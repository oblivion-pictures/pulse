import AVFoundation
import CallKit
import LiveKit

/// Die Session-Seite des Systemanrufs: Ende, Rückgabe und Ausgabe — aus
/// `SpracheSystemanruf.swift` herausgelöst, damit beide unter der
/// Grössen-Policy bleiben (`PLAN.md` §12.1).
///
/// **`private` gilt in Swift je DATEI.** Deshalb sind die Glieder, die beide
/// Dateien brauchen, hier und dort intern statt privat. Die Begründungen
/// stehen an den Stellen selbst; der Kopf von `SpracheSystemanruf.swift`
/// sagt, warum es den Systemanruf überhaupt gibt.
///
/// **Kategorie und Maschine stellt die Anruf-Verwaltung**, wie beim
/// 1:1-Anruf (`AnrufSitzung.swift::kategorieSetzen`, `maschineStellen`):
/// eine Fassung für beide Wege statt einer zweiten Abschrift.
extension SpracheSystemanruf {
    // MARK: - Enden

    /// Der Systemanruf wird bei CallKit beendet; die Session kommt mit
    /// `didDeactivate` zurück (`fortsetzen`). Aus `raumLoesen`, wenn der Raum
    /// sich auflöst — und über `weichen` in allen anderen Fällen.
    func beenden(grund: String) {
        aufHauptthread { [self] in
            guard fuehrt else { return }
            if let u = uuid {
                Anrufverwaltung.geteilt.anbieter?.reportCall(with: u, endedAt: nil, reason: .remoteEnded)
            }
            fortsetzen(grund: grund)
        }
    }

    /// Der Systemanruf endet, der KANAL läuft weiter. Rufer: ein 1:1-Anruf
    /// wird gemeldet oder begonnen (`AnrufPush.swift`, `AnrufCallKit.swift`),
    /// der Schalter ging aus, oder ein neuer Beitritt kommt
    /// (`SpracheSystemanruf.swift`). Für die 1:1-Rufer muss es im selben
    /// Lauf geschehen wie das Melden — die Hülle trägt einen CallKit-Anruf.
    /// Diese Aufrufer laufen auf dem Hauptthread, und dort führt
    /// `aufHauptthread` sofort aus.
    func weichen(grund: String) { beenden(grund: "weichen_" + grund) }

    /// `providerDidReset`: Das System hat alle Anrufe fallen lassen, auch den
    /// des Kanals. Der Kanal bleibt — die Session gehört wieder dem SDK. Nur
    /// auf dem Hauptthread.
    func zurueckgesetzt() {
        let fuehrte = fuehrt || rueckgabeAusstehend
        fristenUhr?.cancel()
        fristenUhr = nil
        rueckgabeUhr?.cancel()
        rueckgabeUhr = nil
        fortsetzung?.resume(returning: false)
        fortsetzung = nil
        sperre.withLock {
            _fuehrt = false
            _uuid = nil
            _rueckgabeAusstehend = false
        }
        sessionAktiv = false
        guard fuehrte else { return }
        SpracheRaum.geteilt.diagMelden("systemanruf_zurueckgesetzt", [:])
        Self.zurueckgeben()
    }

    /// Der Anruf ist weg; die Session kommt mit `didDeactivate` zurück. Nur
    /// auf dem Hauptthread.
    func fortsetzen(grund: String) {
        fristenUhr?.cancel()
        fristenUhr = nil
        fortsetzung?.resume(returning: false)
        fortsetzung = nil
        sessionAktiv = false
        sperre.withLock {
            _fuehrt = false
            _uuid = nil
            _rueckgabeAusstehend = true
        }
        SpracheRaum.geteilt.diagMelden("systemanruf_beendet", ["grund": grund])
        let uhr = DispatchWorkItem { [weak self] in self?.rueckgabeAbschliessen(zwang: true) }
        rueckgabeUhr = uhr
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.rueckgabeFrist, execute: uhr)
    }

    /// `didDeactivate` nach dem Ende, oder die Uhr. Führt inzwischen ein
    /// 1:1-Anruf — der Kanal ist ihm gewichen —, gehört die Session ihm; sein
    /// Ende gibt sie zurück (`AnrufSitzung.sessionZurueckgeben`). Nur auf dem
    /// Hauptthread.
    func rueckgabeAbschliessen(zwang: Bool = false) {
        guard rueckgabeAusstehend else { return }
        rueckgabeUhr?.cancel()
        rueckgabeUhr = nil
        sperre.withLock { _rueckgabeAusstehend = false }
        guard !Anrufverwaltung.geteilt.callkitAktiv else { return }
        if zwang {
            NSLog("[PulseSprache] Systemanruf: CallKit hat die Session nicht abgegeben — Rückgabe trotzdem")
        }
        // Der Übergabeweg: erst sperren, dann freigeben — nur so richtet das
        // SDK die Session beim Wiederanlaufen neu ein (`engineWillEnable`).
        Anrufverwaltung.geteilt.maschineStellen(.none, "anhalten")
        Self.zurueckgeben()
    }

    // MARK: - Ausgabe

    /// Hörmuschel oder Lautsprecher bei führendem Systemanruf — der zweite
    /// Weg wie beim 1:1-Anruf (`AnrufSitzung.ausgabeAnwenden`): Ohne
    /// Automatik liest das SDK `isSpeakerOutputPreferred` nicht.
    func ausgabe(lautsprecher: Bool) {
        aufHauptthread { [self] in
            guard fuehrt, sessionAktiv else { return }
            Self.ausgabeAnwenden(lautsprecher: lautsprecher)
        }
    }

    static func ausgabeAnwenden(lautsprecher: Bool) {
        do {
            try AVAudioSession.sharedInstance().overrideOutputAudioPort(
                lautsprecher ? .speaker : .none)
        } catch {
            NSLog("[PulseSprache] Systemanruf: Ausgabe stellen fehlgeschlagen: %@",
                error.localizedDescription)
        }
    }

    // MARK: - Rückgabe

    /// `.default`; ohne Mikrofon-Erlaubnis nur die Ausgabe (sonst wirft das
    /// SDK `deviceAccessDenied`, und man hörte nicht einmal).
    static func maschineFreigeben() {
        let ziel = Anrufverwaltung.mikrofonErlaubt()
            ? AudioEngineAvailability.default
            : AudioEngineAvailability(isInputAvailable: false, isOutputAvailable: true)
        Anrufverwaltung.geteilt.maschineStellen(ziel, "freigeben")
    }

    /// An das SDK zurück: Übersteuerung weg, Automatik an, Maschine frei —
    /// und der Bluetooth-Weg gleicht neu ab: Die Übernahme hatte ihn
    /// losgelassen (`SpracheSystemanruf.swift::uebernehmen`), und jede andere
    /// Stelle, die die Automatik wieder anstellt, stösst ihn an.
    static func zurueckgeben() {
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.none)
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = true
        maschineFreigeben()
        StreamTonSitzung.geteilt.automatikAn(grund: "systemanruf")
        SpracheRaum.geteilt.funkHqAnstossen("systemanruf")
    }
}
