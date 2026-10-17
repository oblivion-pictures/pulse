import AVFoundation
import LiveKit

/// Bluetooth-Kopfhörer in hoher Qualität im nativen Sprachkanal (iOS 26,
/// Kopfhörer, die es tragen — etwa AirPods Pro 2).
///
/// **Der Befund, gegen den das steht** (TestFlight 8.1): mit Bluetooth-
/// Kopfhörern klang der Kanal verrauscht, ohne Kanal (nur Stream-Ton) nicht.
/// Mit offenem Mikrofon schaltet iOS den Kopfhörer ins Freisprech-Profil HFP
/// (8 oder 16 kHz, mono), und das betrifft alles Gehörte — Stimmen wie
/// Stream-Ton. Das SDK richtet die Session mit `[.allowBluetoothHFP,
/// .allowBluetoothA2DP, .allowAirPlay]` ein (LiveKit 2.17,
/// `AudioSessionConfiguration.swift`); einen Weg an HFP vorbei kennt es nicht.
///
/// **Was iOS 26 dafür hat, im SDK-Kopf gelesen** (`AVAudioSessionTypes.h`,
/// `AVAudioSessionCategoryOptionBluetoothHighQualityRecording`): volle
/// Bandbreite in BEIDE Richtungen, wenn die Route es trägt, „derzeit nur mit
/// `AVAudioSessionModeDefault`" — also ohne Apples Sprachverarbeitung (VPIO
/// gehört zu `.voiceChat`/`.videoChat`). Ob ein Kopfhörer es kann, sagt der
/// Eingang (`bluetoothMicrophoneExtension.highQualityRecording.isSupported`),
/// ob es läuft, dasselbe Feld mit `isEnabled`. Zusammen mit
/// `.allowBluetoothHFP` ist HFP der Rückfall, wenn die Route es nicht trägt.
/// **Apple schreibt dazu ausdrücklich:** die Option „kann die Eingangslatenz
/// erhöhen und wird für Echtzeit-Kommunikation nicht empfohlen" — deshalb ist
/// sie abschaltbar (`wunsch`, Spracheinstellungen; Eigentümer-Freigabe
/// 2026-10-17: automatisch, nur mit HQ-fähigen Kopfhörern, Vorgabe an).
///
/// **Warum wir die Session während HQ SELBST halten** (Gegenprüfung B2).
/// Die erste Fassung hängte die Option hinter die Konfiguration des SDK —
/// aber das SDK setzt bei JEDER eigenen Konfiguration seine festen Optionen
/// ohne HQ (Stream-Kachel auf/zu, Lautsprecher-Wahl, Neubau der Maschine), und
/// jedes Mal hätte der Kopfhörer zweimal das Profil gewechselt, im Neubau
/// womöglich in einer Schleife. Einen Haken ins SELBE `setCategory` gibt es in
/// 2.17 nicht: `sessionConfiguration` wird nirgends gelesen,
/// `customConfigureAudioSessionFunc` ist veraltet und ersetzt auch das
/// Aktivieren, und `AudioSessionEngineObserver` ist nicht ableitbar (`public`,
/// nicht `open`) — ihn in `set(engineObservers:)` zu ersetzen nähme dem
/// Stream-Ton die Anforderungen, über die er die Session bekommt
/// (`StreamTonSitzung`).
///
/// Also derselbe Weg wie bei CallKit (`AnrufSitzung.swift`): Automatik aus
/// (`isAutomaticConfigurationEnabled = false`), Kategorie selbst setzen. Die
/// Buchführung des SDK läuft dabei weiter (Anforderungen, `hasRecorded`), nur
/// `configureIfNeeded` kehrt sofort zurück — kein `setCategory`, kein
/// `setActive(false)` beim Neubau der Maschine. Zurück an die Automatik geht
/// es beim Verlassen, ohne Kopfhörer, bei jedem Anruf und wenn HQ nicht
/// anspringt; die Heilwege des Wächters stellen sie ohnehin zurück
/// (`maschineNeu`), danach übernimmt der Abgleich neu — gebremst.
final class SpracheFunkHq: @unchecked Sendable {
    static let geteilt = SpracheFunkHq()

    private let sperre = NSLock()
    private var _wunsch = true
    private var _haelt = false
    private var uebernahmen: [CFAbsoluteTime] = []
    /// Für diesen Raum aufgegeben (HQ springt nicht an, oder es pendelt).
    var gescheitert = false
    /// Zuletzt gemeldete Route — eine Diagnose-Zeile nur bei Wechsel.
    var letzteArt = ""

    /// Will der Nutzer den HQ-Weg? Vorgabe an; gesetzt vom Web.
    var wunsch: Bool {
        get { sperre.withLock { _wunsch } }
        set { sperre.withLock { _wunsch = newValue } }
    }

    /// Halten wir die Session gerade (Automatik von uns aus)?
    var haelt: Bool { sperre.withLock { _haelt } }

    /// **Pendelbremse:** mehr als `pendelGrenze` Übernahmen in `pendelFenster`
    /// Sekunden heisst, irgendetwas gibt sie immer wieder zurück — dann lieber
    /// VPIO als Profilwechsel im Sekundentakt. `true` = die Bremse greift.
    static let pendelGrenze = 3
    static let pendelFenster: CFAbsoluteTime = 30

    func uebernahmeZaehlen(_ jetzt: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> Bool {
        sperre.withLock {
            uebernahmen = uebernahmen.filter { jetzt - $0 < Self.pendelFenster } + [jetzt]
            return uebernahmen.count > Self.pendelGrenze
        }
    }

    /// Gibt die Session ans SDK zurück, falls wir sie halten. Von jedem Faden:
    /// es ist nur ein Merker und der Schalter des SDK (dort hinter dessen
    /// Sperre). Neu einrichten tut das SDK erst beim nächsten Wechsel — den
    /// stösst der Abgleich an (Verarbeitung zurück auf `.automatic`).
    @discardableResult
    func loslassen() -> Bool {
        let hielt = sperre.withLock { () -> Bool in
            defer { _haelt = false }
            return _haelt
        }
        if hielt { AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = true }
        return hielt
    }

    /// Jemand anderes hat die Automatik schon zurückgestellt (Heilweg).
    func verloren() { sperre.withLock { _haelt = false } }

    func raumWeg() {
        entdaempfen(grund: "raum_weg")
        loslassen()
        sperre.withLock { uebernahmen = [] }
        gescheitert = false
        letzteArt = ""
    }

    // MARK: - Dämpfung (Gegenprüfung B3)

    private var gedaempftSeit: CFAbsoluteTime?
    private var vorherLautstaerke: Float = 1

    /// **Kopfhörer raus, während wir HQ halten.** iOS leitet SOFORT auf den
    /// Lautsprecher um; VPIO ist da noch aus, und bis der Abgleich in der
    /// Kette dran ist und die Maschine mit VPIO neu steht, liefe der Kanal
    /// laut über den Lautsprecher mit nur WebRTCs Echo-Unterdrückung — die
    /// Lage, die als „Volle Tonqualität" wegen Hall abgeschaltet wurde.
    /// Deshalb hier, im Routen-Beobachter und ohne Kette: Session zurück an
    /// das SDK und die Wiedergabe des Kanals stumm, bis VPIO wieder läuft.
    func kopfhoererWeg() {
        guard haelt, !FunkLage.lesen().ausgangFunk else { return }
        daempfen()
        loslassen()
    }

    /// Die Wiedergabe des Kanals stumm (LiveKits Mischer; der Stream-Ton hat
    /// seine eigene Maschine und bleibt hörbar), bis die Verarbeitung zurück
    /// ist und VPIO läuft — höchstens `daempfungHoechstens` Sekunden.
    func daempfen() {
        let neu = sperre.withLock { () -> Bool in
            guard gedaempftSeit == nil else { return false }
            gedaempftSeit = CFAbsoluteTimeGetCurrent()
            return true
        }
        guard neu else { return }
        let mixer = AudioManager.shared.mixer
        let vorher = mixer.outputVolume
        sperre.withLock { vorherLautstaerke = vorher }
        mixer.outputVolume = 0
        DispatchQueue.global().async { SpracheRaum.geteilt.diagMelden("funk_daempfung", ["an": true]) }
        daempfungPruefen()
    }

    static let daempfungHoechstens: CFAbsoluteTime = 8
    /// Ohne VPIO-Rückmeldung (Simulator, oder sie kommt nicht): so lange nach
    /// dem Zurückstellen der Verarbeitung, dann wieder hörbar.
    static let daempfungOhneVpio: CFAbsoluteTime = 1.5

    /// Liest die blockierenden Getter des SDK auf einem eigenen Faden, nie auf
    /// einem von WebRTC (dieselbe Regel wie `tonBeleg`).
    private func daempfungPruefen() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { [self] in
            guard let seit = sperre.withLock({ gedaempftSeit }) else { return }
            let dauer = CFAbsoluteTimeGetCurrent() - seit
            let am = AudioManager.shared
            let zurueck = am.audioProcessingState.echoCancellation.requested?.mode != .software
            let vpio = am.platformVoiceProcessingState.voiceProcessingEnabled.isActive
            if zurueck, vpio || dauer >= Self.daempfungOhneVpio {
                entdaempfen(grund: vpio ? "vpio" : "frist")
            } else if dauer >= Self.daempfungHoechstens {
                entdaempfen(grund: "hoechstens")
            } else {
                daempfungPruefen()
            }
        }
    }

    func entdaempfen(grund: String) {
        let vorher = sperre.withLock { () -> Float? in
            guard gedaempftSeit != nil else { return nil }
            gedaempftSeit = nil
            return vorherLautstaerke
        }
        guard let vorher else { return }
        AudioManager.shared.mixer.outputVolume = vorher
        DispatchQueue.global().async {
            SpracheRaum.geteilt.diagMelden("funk_daempfung", ["an": false, "grund": grund])
        }
    }

    // MARK: - Session (auf dem Hauptthread, wie die CallKit-Übergabe)

    /// Übernehmen, Schritt 1: die Automatik nehmen — nur, wenn kein Anruf die
    /// Session führt und niemand sonst sie gerade hält. Auf dem Hauptthread,
    /// weil dort auch `sessionUebernehmen` läuft: CallKit kann so nicht
    /// zwischen Prüfen und Nehmen fallen.
    @MainActor func automatikNehmen() -> Bool {
        let v = Anrufverwaltung.geteilt
        let am = AudioManager.shared
        guard !v.callkitAktiv, !v.ohneCallKit, AnrufRaum.geteilt.raum == nil,
              am.audioSession.isAutomaticConfigurationEnabled else { return false }
        am.audioSession.isAutomaticConfigurationEnabled = false
        sperre.withLock { _haelt = true }
        return true
    }

    /// Übernehmen, Schritt 2: die Kategorie, die das SDK für
    /// Software-Verarbeitung setzt (`playAndRecord…Media`, Modus `.default`),
    /// plus HQ. `nil` = eingerichtet, sonst der Grund.
    @MainActor func hqEinrichten() -> String? {
        guard haelt, !Anrufverwaltung.geteilt.callkitAktiv else { return "verloren" }
        guard #available(iOS 26.0, *) else { return "ios" }
        var optionen = Self.sdkOptionen()
        optionen.insert(.bluetoothHighQualityRecording)
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playAndRecord, mode: .default, options: optionen)
            // Im Kanal ist sie schon aktiv; nach einer Unterbrechung womöglich
            // nicht — und solange wir halten, aktiviert das SDK nicht.
            try s.setActive(true)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Die Kategorie, die das SDK selbst setzen würde — für ein Zurückgeben,
    /// das keinen Wechsel der Verarbeitung auslöst (dann richtet das SDK von
    /// selbst nichts neu ein, und die HQ-Option bliebe stehen).
    @MainActor func sdkKategorieSetzen(software: Bool) {
        let am = AudioManager.shared
        guard am.audioSession.isAutomaticConfigurationEnabled,
              !Anrufverwaltung.geteilt.callkitAktiv else { return }
        let lautsprecher = am.isSpeakerOutputPreferred
        let modus: AVAudioSession.Mode = software ? .default : (lautsprecher ? .videoChat : .voiceChat)
        try? AVAudioSession.sharedInstance().setCategory(
            .playAndRecord, mode: modus, options: Self.sdkOptionen())
    }

    /// Die Optionen der `playAndRecord`-Vorgaben des SDK 2.17.
    @MainActor static func sdkOptionen() -> AVAudioSession.CategoryOptions {
        var o: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay]
        if AudioManager.shared.isSpeakerOutputPreferred { o.insert(.defaultToSpeaker) }
        return o
    }
}
