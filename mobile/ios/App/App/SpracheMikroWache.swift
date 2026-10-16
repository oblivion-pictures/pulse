import AVFoundation
import CallKit
import LiveKit

/// Zählt die Puffer, die das eigene Mikrofon liefert — am Ende der
/// Aufnahme-Verarbeitung des SDK (`AudioManager.add(localAudioRenderer:)`,
/// derselbe Haken, mit dem das SDK selbst auf das erste Bild wartet:
/// `LocalAudioTrack.startWaitingForFrames`).
///
/// **Warum es das braucht** (Befund TestFlight 2.1): im Sprachkanal fiel das
/// Mikrofon aus, ohne dass es irgendwo sichtbar wurde — kein oranger Punkt, der
/// Desktop hörte nichts, und die Oberfläche zeigte ein offenes Mikrofon. Ein
/// stehender Aufnahmepfad liefert schlicht keine Puffer mehr; genau das zählt
/// diese Klasse.
///
/// Läuft auf dem Audio-Faden des SDK: nur eine Sperre und drei Zahlen, kein
/// Brückenverkehr, keine Zuteilung.
final class MikroPufferZaehler: NSObject, AudioRenderer, @unchecked Sendable {
    private let sperre = NSLock()
    private var anzahl: UInt64 = 0
    private var spitze: Float = 0
    private var zuletzt: CFAbsoluteTime = 0
    private var beimErsten: (() -> Void)?

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let p = Self.spitze(pcmBuffer)
        let jetzt = CFAbsoluteTimeGetCurrent()
        sperre.lock()
        anzahl &+= 1
        if p > spitze { spitze = p }
        zuletzt = jetzt
        let erster = beimErsten
        beimErsten = nil
        sperre.unlock()
        erster?()
    }

    /// Einmal rufen, sobald der nächste Puffer kommt — für „das Mikrofon
    /// liefert", ohne auf den nächsten Takt zu warten.
    func beimNaechsten(_ f: @escaping () -> Void) {
        sperre.lock()
        beimErsten = f
        sperre.unlock()
    }

    /// Stand lesen; die Spitze gilt seit dem letzten Ablesen.
    func ablesen() -> (anzahl: UInt64, spitze: Float, zuletzt: CFAbsoluteTime) {
        sperre.lock()
        defer {
            spitze = 0
            sperre.unlock()
        }
        return (anzahl, spitze, zuletzt)
    }

    /// Spitze 0…1. Das SDK reicht Int16 (`LKAudioBuffer.toAVAudioPCMBuffer`);
    /// Float wird der Vollständigkeit halber gelesen.
    static func spitze(_ b: AVAudioPCMBuffer) -> Float {
        let n = Int(b.frameLength)
        guard n > 0 else { return 0 }
        if let k = b.int16ChannelData?[0] {
            var m: Int32 = 0
            for i in 0 ..< n { m = max(m, abs(Int32(k[i]))) }
            return Float(m) / 32768
        }
        if let k = b.floatChannelData?[0] {
            var m: Float = 0
            for i in 0 ..< n { m = max(m, abs(k[i])) }
            return m
        }
        return 0
    }
}

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
    /// So lange gilt eine offene Unterbrechung als fremd und berechtigt (Siri,
    /// Wecker, eine andere App). Danach, im Vordergrund und ohne fremden Ton,
    /// ist es das Bild von K1: WebKit hat die Session genommen und gibt sie
    /// nie mit „Ende" zurück. Gesetzt, nicht gemessen.
    static let unterbrechungsGeduld: CFAbsoluteTime = 15

    /// Dürfen die Stufen 2 und 3 die Audio-Kette anfassen?
    ///
    /// **Nicht gegen einen fremden Halter der Session** (Gegenprüfung T1). Die
    /// Maschine neu freizugeben heisst für das SDK, die Session zu aktivieren —
    /// und das lehnt iOS gegen eine laufende fremde Unterbrechung oder aus dem
    /// Hintergrund ab (`cannotInterruptOthers`, `insufficientPriority`). Dann
    /// stünde die Maschine auf `.none`, und auch nach dem Ende der Unterbrechung
    /// liefe weder Mikrofon noch Wiedergabe. In diesen Lagen wartet der Wächter
    /// und setzt beim Ende der Unterbrechung oder im Vordergrund neu an.
    static func eingreifenErlaubt(vordergrund: Bool, fremdTon: Bool,
                                  unterbrochenSeit: CFAbsoluteTime?, jetzt: CFAbsoluteTime) -> Bool {
        guard vordergrund, !fremdTon else { return false }
        guard let seit = unterbrochenSeit else { return true }
        return jetzt - seit >= unterbrechungsGeduld
    }

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
    /// Die Maschine steht nach einem gescheiterten Freigeben auf `.none` —
    /// wird bei jeder Prüfung erneut versucht, auch nach Stufe 4: die
    /// Wiedergabe muss zurückkommen, selbst wenn das Mikrofon tot bleibt.
    private var maschineOffen = false
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

    /// Ob das Freigeben der Maschine gelang (`SpracheRaum.maschineNeu`); wenn
    /// nicht, holt die nächste erlaubte Prüfung es nach.
    func maschineStand(frei: Bool) {
        faden.async { [self] in maschineOffen = !frei }
    }

    /// Vordergrund oder Hintergrund (`SpracheRaumSession.swift`) — auch ohne
    /// Raum gemeldet, damit der Merker nie hängen bleibt. Zurück im
    /// Vordergrund wird sofort geprüft.
    func vordergrund(_ an: Bool) {
        faden.async { [self] in
            vordergrund = an
            guard an, uhr != nil else { return }
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
        let erlaubt = eingreifenJetzt(jetzt)
        if maschineOffen, erlaubt, sprache.raum != nil {
            maschineOffen = false
            Task { await self.sprache.maschineFreigeben() }
        }
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
        if stufe >= 1, !erlaubt {
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

    private func eingreifenJetzt(_ jetzt: CFAbsoluteTime) -> Bool {
        let s = AVAudioSession.sharedInstance()
        return Self.eingreifenErlaubt(
            vordergrund: vordergrund,
            fremdTon: s.isOtherAudioPlaying || s.secondaryAudioShouldBeSilencedHint,
            unterbrochenSeit: unterbrochenSeit, jetzt: jetzt)
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
