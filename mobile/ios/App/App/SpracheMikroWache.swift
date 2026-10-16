import AVFoundation
import CallKit
import LiveKit

/// Der Wächter über das Mikrofon im nativen Sprachkanal.
///
/// **Was er prüft.** Alle 2 s: steht der Raum, will der Nutzer sprechen
/// (offen, nicht angehalten, kein Anruf), aber kam 4 s lang kein Puffer — oder
/// steht die Audio-Maschine? Dann eine Leiter, eine Stufe je 4 s, jede für sich
/// gemeldet (`diagnose`):
///
/// 1. `mikroAusfall` ans Web: WebKit erklärt seine Session neu (`ambient`).
///    Heilt den Fall, dass ein nicht mischbarer WebKit-Ton uns die Session
///    genommen hat (Kette K1 in der Befundakte vom 2026-10-17).
/// 2. Die Maschine neu anstossen — derselbe Übergabeweg wie bei CallKit
///    (`SpracheRaum.maschineNeu`). Heilt hängende Buchführung (K2).
/// 3. Die Mikrofonspur neu veröffentlichen.
/// 4. Aufgeben: `mikroTot` — die Oberfläche bietet „Erneut verbinden" an.
///
/// Kommen wieder Puffer, ist alles vorbei (`wache_erholt`), auch nach Stufe 4.
///
/// **Nicht während eines Telefonats.** Ein laufendes Mobilfunk- oder
/// FaceTime-Gespräch nimmt uns die Session zu Recht; dagegen anzukämpfen hiesse,
/// das Telefonat zu stören. `CXCallObserver` sieht auch fremde Gespräche.
///
/// **Ungemessen:** ob ein stummgeschaltetes Mikrofon weiter Puffer liefert.
/// Deshalb prüft der Wächter nur bei OFFENEM Mikrofon und zählt die 4 s ab dem
/// Moment, in dem es offen ist.
final class SpracheMikroWache: @unchecked Sendable {
    static let stilleGrenze: CFAbsoluteTime = 4
    static let takt: TimeInterval = 2
    private let faden = DispatchQueue(label: "com.howispulse.sprache.wache")
    private let zaehler = MikroPufferZaehler()
    private let anrufe = CXCallObserver()
    private var uhr: DispatchSourceTimer?
    // Ab hier nur auf `faden`.
    private var erwartetSeit: CFAbsoluteTime?
    private var stufe = 0
    private var stufeSeit: CFAbsoluteTime = 0
    private var bereitGemeldet = false
    private var telefonatGemeldet = false
    private var letzteAnzahl: UInt64 = 0
    private var unterbrechungsUhr: DispatchWorkItem?
    private var unterbrochenSeit: CFAbsoluteTime?
    private var vordergrund = true
    private var wartenGemeldet = false
    // Nachholen einer gesperrten Maschine (`nachholenFallsNoetig`).
    private var nachholLaeuft = false
    private var nachholenAb: CFAbsoluteTime = 0
    private var nachholAbstand: TimeInterval = WacheRegeln.nachholStart
    private var nachholFehlerGemeldet = false
    /// Aufgegeben (Stufe 4)? Gelesen auch vom Zustand — ein `Bool`, das der
    /// Faden schreibt und andere lesen (wie die übrigen Felder des Raums).
    private(set) var tot = false

    private var sprache: SpracheRaum { SpracheRaum.geteilt }

    /// Nach dem Veröffentlichen der Spur (`SpracheRaum.beitreten`).
    /// `vordergrund`: der Stand der App jetzt — ein Merker aus einem früheren
    /// Raum gilt nicht mit (Gegenprüfung 2, U1).
    func beginnen(vordergrund vorn: Bool) {
        faden.async { [self] in
            vordergrund = vorn
            nachholZuruecksetzen()
            stufe = 0
            tot = false
            bereitGemeldet = false
            telefonatGemeldet = false
            wartenGemeldet = false
            erwartetSeit = nil
            letzteAnzahl = zaehler.ablesen().anzahl
            zaehler.beimNaechsten { [weak self] in
                self?.faden.async { self?.bereitMelden() }
            }
            if uhr == nil {
                AudioManager.shared.add(localAudioRenderer: zaehler)
                let t = DispatchSource.makeTimerSource(queue: faden)
                t.schedule(deadline: .now() + Self.takt, repeating: Self.takt, leeway: .milliseconds(200))
                t.setEventHandler { [weak self] in self?.pruefen() }
                t.resume()
                uhr = t
            }
            pruefen()
        }
    }

    /// Vordergrund oder Hintergrund (`SpracheRaumSession.swift`) — auch ohne
    /// Raum gemeldet, damit der Merker nie hängen bleibt. Zurück im
    /// Vordergrund wird sofort geprüft und das Nachholen nicht mehr verzögert.
    func vordergrund(_ an: Bool) {
        faden.async { [self] in
            vordergrund = an
            guard an, uhr != nil else { return }
            nachholZuruecksetzen()
            pruefen()
        }
    }

    /// Mit dem Raum (`SpracheRaum.raumLoesen`).
    func beenden() {
        faden.async { [self] in
            uhr?.cancel()
            uhr = nil
            unterbrechungsUhr?.cancel()
            unterbrechungsUhr = nil
            AudioManager.shared.remove(localAudioRenderer: zaehler)
            erwartetSeit = nil
            if tot { totSetzen(false) }
            stufe = 0
        }
    }

    /// Aufgegeben oder wieder da — ans Web und an die native Ansicht, die
    /// über der Web-Leiste liegt und sonst nichts davon zeigte.
    private func totSetzen(_ an: Bool) {
        tot = an
        sprache.wacheMelden("mikroTot", ["tot": an])
        DispatchQueue.main.async { SpracheStand.geteilt.mikroTot = an }
    }

    /// Sofort prüfen — nach dem Ende einer Unterbrechung, beim Wechsel in den
    /// Vordergrund, nach einem Neustart der Mediendienste. Fasst selbst nichts
    /// an; die Leiter entscheidet wie im Takt.
    func anstossen(_ grund: String) {
        faden.async { [self] in
            guard uhr != nil else { return }
            sprache.diagMelden("wache_anstoss", ["grund": grund, "stufe": stufe])
            pruefen()
        }
    }

    /// Eine Unterbrechung der Session begann oder endete. Endet sie nicht
    /// binnen 10 s, und ist es kein Telefonat, hängt sie — genau das Bild von
    /// K1, in dem WebKit die Session nimmt und nie mit „Ende" zurückgibt. Das
    /// Ende selbst stösst eine sofortige Prüfung an.
    func unterbrechung(begonnen: Bool) {
        faden.async { [self] in
            unterbrechungsUhr?.cancel()
            unterbrechungsUhr = nil
            unterbrochenSeit = begonnen ? CFAbsoluteTimeGetCurrent() : nil
            guard uhr != nil else { return }
            guard begonnen else {
                nachholZuruecksetzen()
                pruefen()
                return
            }
            let u = DispatchWorkItem { [weak self] in
                guard let self, uhr != nil, !telefonatLaeuft() else { return }
                sprache.diagMelden("unterbrechung_haengt", ["nach_s": 10])
            }
            unterbrechungsUhr = u
            faden.asyncAfter(deadline: .now() + 10, execute: u)
        }
    }

    // MARK: - Prüfen

    private func pruefen() {
        let jetzt = CFAbsoluteTimeGetCurrent()
        let stand = zaehler.ablesen()
        let neue = stand.anzahl &- letzteAnzahl
        letzteAnzahl = stand.anzahl
        nachholenFallsNoetig(jetzt)
        guard sollLiefern() else {
            erwartetSeit = nil
            return
        }
        let seit = erwartetSeit ?? jetzt
        erwartetSeit = seit
        let maschine = AudioManager.shared.isEngineRunning
        if neue > 0 && maschine {
            erholt(stand.spitze)
            return
        }
        let still = jetzt - max(stand.zuletzt, seit)
        let maschineSteht = !maschine && jetzt - seit >= Self.takt
        guard still >= Self.stilleGrenze || maschineSteht else { return }
        if telefonatLaeuft() {
            if !telefonatGemeldet {
                telefonatGemeldet = true
                sprache.diagMelden("wache_telefonat", ["still_s": Int(still)])
            }
            return
        }
        telefonatGemeldet = false
        guard !tot, stufe == 0 || jetzt - stufeSeit >= Self.stilleGrenze else { return }
        if !stufeErlaubt(stufe + 1, jetzt) {
            if !wartenGemeldet {
                wartenGemeldet = true
                sprache.diagMelden("wache_wartet", [
                    "vordergrund": vordergrund, "unterbrochen": unterbrochenSeit != nil
                ])
            }
            return
        }
        wartenGemeldet = false
        stufe += 1
        stufeSeit = jetzt
        stufeAusfuehren(stufe, still: still, maschine: maschine)
    }

    private func stufeErlaubt(_ naechste: Int, _ jetzt: CFAbsoluteTime) -> Bool {
        let s = AVAudioSession.sharedInstance()
        return WacheRegeln.stufeErlaubt(
            naechste, vordergrund: vordergrund,
            fremdTon: s.isOtherAudioPlaying || s.secondaryAudioShouldBeSilencedHint,
            unterbrochenSeit: unterbrochenSeit, jetzt: jetzt)
    }

    // MARK: - Nachholen

    /// **Steht die Maschine gesperrt, ohne dass ein Anruf sie führt, wird sie
    /// freigegeben** — gelesen am wahren Stand, nicht an einem Merker
    /// (Gegenprüfung 2, U5): so fällt auch eine gescheiterte CallKit-Rückgabe
    /// auf, und es greift auch bei stummem Mikrofon. Unter denselben Regeln wie
    /// Stufe 2, nicht während eines Telefonats, mit Rückzug 2 → 4 → 8 … 30 s
    /// (U4); gemeldet wird nur der erste Fehlschlag.
    private func nachholenFallsNoetig(_ jetzt: CFAbsoluteTime) {
        guard !nachholLaeuft, jetzt >= nachholenAb, sprache.raum != nil else { return }
        let v = Anrufverwaltung.geteilt
        guard !v.callkitAktiv, !v.ohneCallKit,
              WacheRegeln.maschineGesperrt(AudioManager.shared.engineAvailability,
                                           erlaubt: Anrufverwaltung.mikrofonErlaubt()),
              !telefonatLaeuft(), stufeErlaubt(2, jetzt) else { return }
        nachholLaeuft = true
        let melden = !nachholFehlerGemeldet
        Task {
            let frei = await self.sprache.maschineFreigeben(melden: melden)
            self.faden.async { [self] in
                nachholLaeuft = false
                if frei {
                    nachholZuruecksetzen()
                } else {
                    nachholFehlerGemeldet = true
                    nachholenAb = CFAbsoluteTimeGetCurrent() + nachholAbstand
                    nachholAbstand = WacheRegeln.naechsterNachholAbstand(nachholAbstand)
                }
            }
        }
    }

    private func nachholZuruecksetzen() {
        nachholenAb = 0
        nachholAbstand = WacheRegeln.nachholStart
        nachholFehlerGemeldet = false
    }

    /// Das Mikrofon liefert — einmal je Beitritt. Das Web spielt erst danach
    /// seinen Beitrittston (`nativerRaum.svelte.ts`).
    private func bereitMelden() {
        guard uhr != nil, !bereitGemeldet else { return }
        bereitGemeldet = true
        sprache.wacheMelden("mikroBereit", [:])
    }

    private func erholt(_ spitze: Float) {
        bereitMelden()
        guard stufe > 0 || tot else { return }
        sprache.diagMelden("wache_erholt", ["stufe": stufe, "spitze": Double(spitze)])
        if tot { totSetzen(false) }
        stufe = 0
    }

    private func stufeAusfuehren(_ s: Int, still: CFAbsoluteTime, maschine: Bool) {
        sprache.diagMelden("wache_stufe", [
            "stufe": s, "still_s": Int(still), "engineLaeuft": maschine
        ])
        switch s {
        case 1:
            sprache.wacheMelden("mikroAusfall", ["stufe": 1])
        case 2:
            Task { await self.sprache.maschineNeu(grund: "wache") }
        case 3:
            Task { await self.sprache.mikrofonspurNeu() }
        default:
            totSetzen(true)
        }
    }

    /// Verbunden, offen, nicht angehalten, kein Anruf der App.
    private func sollLiefern() -> Bool {
        let sr = sprache
        guard let r = sr.raum, r.connectionState == .connected else { return false }
        guard sr.mikroWunsch, !sr.anrufPausiert, sr.mikrofonFehler == nil else { return false }
        guard r.localParticipant.isMicrophoneEnabled() else { return false }
        let v = Anrufverwaltung.geteilt
        return !v.callkitAktiv && !v.ohneCallKit
    }

    private func telefonatLaeuft() -> Bool {
        anrufe.calls.contains { !$0.hasEnded }
    }
}
