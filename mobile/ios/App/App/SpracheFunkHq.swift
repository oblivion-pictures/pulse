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
    private var _gescheitert = false
    private var gescheitertSeit: CFAbsoluteTime = 0
    private var letzteRoute: CFAbsoluteTime = 0
    private var letzteArt = ""
    /// Das Gerät, für das wir halten (`uid` des Bluetooth-Ausgangs bei der
    /// Übernahme), und seit wann — Gegenprüfung C1.
    private var haltUid: String?
    private var haltSeit: CFAbsoluteTime = 0
    private var _konfigWechsel = 0
    private var konfigBeobachter: NSObjectProtocol?

    /// Wie oft eine Audio-Maschine in diesem Raum ihre Konfiguration wechseln
    /// musste (`AVAudioEngineConfigurationChange` — darauf baut WebRTCs ADM
    /// mit `ReconfigureEngine` neu). Zählt alle Maschinen des Prozesses, also
    /// auch die des Stream-Tons; ein Pendeln zeigt sich als schnell steigende
    /// Zahl. Diagnose `konfigWechsel` (C5).
    var konfigWechsel: Int { sperre.withLock { _konfigWechsel } }

    func maschinenBeobachtenFallsNoetig() {
        sperre.withLock {
            guard konfigBeobachter == nil else { return }
            konfigBeobachter = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil
            ) { [weak self] _ in
                guard let self else { return }
                sperre.withLock { self._konfigWechsel += 1 }
            }
        }
    }

    /// **Alles hier hinter `sperre`** (Gegenprüfung B7): geschrieben wird aus
    /// der Befehlskette, aber auch aus `raumLoesen` ← `raumAbgerissen` (ein
    /// Delegat des SDK, ausserhalb der Kette), dem Routen-Beobachter und den
    /// Anruf-Wegen auf dem Hauptthread. Der Maschinenweg (WebRTC-Faden) fasst
    /// nichts davon an; `main.sync` gibt es nirgends — `maschineNeu` ruft
    /// `setEngineAvailability` auf dem Hauptthread und wartet dabei auf
    /// WebRTC, das wäre eine Verklemmung.

    /// Für diesen Raum aufgegeben (HQ springt nicht an, oder es pendelt).
    var gescheitert: Bool {
        get { sperre.withLock { _gescheitert } }
        set {
            sperre.withLock {
                if newValue, !_gescheitert { gescheitertSeit = CFAbsoluteTimeGetCurrent() }
                _gescheitert = newValue
            }
        }
    }

    // MARK: - Erholung (Gegenprüfung C6)

    /// Nach so langer ruhiger Route (kein Routenwechsel, seit aufgegeben) darf
    /// HQ im selben Raum wieder versucht werden. Sonst verlor, wer in 30 s
    /// zweimal die AirPods herausnahm, HQ für den ganzen Raum.
    static let erholungNach: CFAbsoluteTime = 120

    func routeGesehen() { sperre.withLock { letzteRoute = CFAbsoluteTimeGetCurrent() } }

    /// Ist die Route seit `frist` ruhig — auch seit der eigenen Übernahme?
    /// Für die Prüfung „läuft HQ noch?": ein Routenwechsel kurz davor heisst,
    /// der Kopfhörer schaltet vielleicht gerade.
    func ruhig(seit frist: CFAbsoluteTime, jetzt: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> Bool {
        sperre.withLock { jetzt - max(letzteRoute, haltSeit) >= frist - 0.05 }
    }

    /// `true`, wenn aufgegeben war und die Route lange genug ruhig ist —
    /// dann gilt der Raum wieder als offen (auch die Pendelbremse).
    func erholen(_ jetzt: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> Bool {
        sperre.withLock {
            guard _gescheitert, jetzt - max(gescheitertSeit, letzteRoute) >= Self.erholungNach
            else { return false }
            _gescheitert = false
            uebernahmen = []
            return true
        }
    }

    /// `true`, wenn sich die gemeldete Route geändert hat — eine
    /// Diagnose-Zeile nur bei Wechsel.
    func artGewechselt(_ kurz: String) -> Bool {
        sperre.withLock {
            defer { letzteArt = kurz }
            return letzteArt != kurz
        }
    }

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

    /// **Darf das Halten weiterlaufen?** (Gegenprüfung C1) Nur für DASSELBE
    /// Gerät: wechselt die Route auf ein anderes Bluetooth-Gerät (Soundbar,
    /// Auto), gilt das wie „Kopfhörer weg" — sonst liefe dort Software-Echo-
    /// Unterdrückung mit eingebautem Mikrofon. Am Porttyp lässt es sich nicht
    /// festmachen (unter HQ unbekannt), an der `uid` schon. Ein fehlender
    /// Bluetooth-Eingang zählt erst nach der Prüffrist: während des eigenen
    /// Umschaltens fehlt er womöglich für einen Augenblick.
    func haltenErlaubt(_ l: FunkLage, jetzt: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> Bool {
        let (uid, seit) = sperre.withLock { (haltUid, haltSeit) }
        guard l.ausgangFunk, uid == nil || l.ausgangUid == uid else { return false }
        return l.eingangFunk || jetzt - seit < SpracheRaum.funkPruefFrist
    }

    func raumWeg() {
        entdaempfen(grund: "raum_weg")
        loslassen()
        sperre.withLock {
            uebernahmen = []
            _gescheitert = false
            _konfigWechsel = 0
            letzteArt = ""
        }
    }

    /// **Abriss von aussen, während wir hielten** (Gegenprüfung C3). Beim
    /// Verlassen gibt `raumLoesen` die Automatik zurück, BEVOR die Maschine
    /// stoppt, und das SDK deaktiviert selbst. Bei einem Abriss meldet LiveKit
    /// erst nach dem Abbau (`didDisconnectWithError` nach `cleanUpRTC`): die
    /// Maschine stand, solange die Automatik noch aus war, das SDK verbuchte
    /// „nichts aktiv" ohne `setActive(false)`, und die Session blieb aktiv —
    /// fremde Musik kam nicht wieder, der Kopfhörer blieb im Aufnahmeprofil.
    /// Deaktiviert wird unter denselben Bedingungen wie nach dem letzten
    /// Stream-Ton (`StreamTonSitzung.nachDemLetzten`: kein Raum, kein Anruf,
    /// kein Stream-Ton) und nur bei stehender Maschine. `isEngineRunning`
    /// fragt WebRTC blockierend — deshalb hier auf einem eigenen Faden, nicht
    /// auf dem Hauptthread.
    func nachAbriss() {
        DispatchQueue.global().async {
            let laeuft = AudioManager.shared.isEngineRunning
            SpracheRaum.geteilt.diagMelden("funk_hq_abriss", ["maschineLaeuft": laeuft])
            guard !laeuft else { return }
            StreamTonSitzung.geteilt.nachDemLetzten()
        }
    }

    // MARK: - Dämpfung (Gegenprüfung B3, C2)

    let daempfung = FunkDaempfung()
    func daempfen() { daempfung.an() }
    func entdaempfen(grund: String) { daempfung.aus(grund: grund) }

    /// **Kopfhörer raus (oder ein anderes Gerät, C1), während wir HQ halten.**
    /// iOS leitet SOFORT auf den Lautsprecher um; VPIO ist da noch aus, und
    /// bis der Abgleich in der Kette dran ist und die Maschine mit VPIO neu
    /// steht, liefe der Kanal laut über den Lautsprecher mit nur WebRTCs
    /// Echo-Unterdrückung — die Lage, die als „Volle Tonqualität" wegen Hall
    /// abgeschaltet wurde. Deshalb hier, im Routen-Beobachter und ohne Kette:
    /// Session zurück an das SDK und die Wiedergabe des Kanals stumm, bis VPIO
    /// wieder läuft. **Mit `volle` nicht stumm** (C2): dort bleibt die
    /// Software-Verarbeitung gewollt, VPIO käme nie, und die Dämpfung stünde
    /// bis zur Obergrenze.
    func kopfhoererWeg(volle: Bool) {
        guard haelt, !haltenErlaubt(FunkLage.lesen()) else { return }
        if !volle { daempfen() }
        loslassen()
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
        guard haelt, !Anrufverwaltung.geteilt.callkitAktiv else { return Self.verlorenGrund }
        guard #available(iOS 26.0, *) else { return "ios" }
        var optionen = Self.sdkOptionen()
        optionen.insert(.bluetoothHighQualityRecording)
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playAndRecord, mode: .default, options: optionen)
            // Im Kanal ist sie schon aktiv; nach einer Unterbrechung womöglich
            // nicht — und solange wir halten, aktiviert das SDK nicht.
            try s.setActive(true)
            let uid = FunkLage.lesen().ausgangUid
            sperre.withLock {
                haltUid = uid
                haltSeit = CFAbsoluteTimeGetCurrent()
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Die Kategorie, die das SDK selbst setzen würde — für ein Zurückgeben,
    /// das keinen Wechsel der Verarbeitung auslöst (dann richtet das SDK von
    /// selbst nichts neu ein, und die HQ-Option bliebe stehen).
    /// `gehalten`: noch während wir halten (Rückgabe, C5) — dann gilt unser
    /// Merker statt des Automatik-Schalters.
    @MainActor func sdkKategorieSetzen(software: Bool, gehalten: Bool = false) {
        let am = AudioManager.shared
        let darf = gehalten ? haelt : am.audioSession.isAutomaticConfigurationEnabled
        guard darf, !Anrufverwaltung.geteilt.callkitAktiv else { return }
        let lautsprecher = am.isSpeakerOutputPreferred
        let modus: AVAudioSession.Mode = software ? .default : (lautsprecher ? .videoChat : .voiceChat)
        try? AVAudioSession.sharedInstance().setCategory(
            .playAndRecord, mode: modus, options: Self.sdkOptionen())
    }

    /// Zwischen Nehmen und Einrichten hat ein Anruf oder `kopfhoererWeg` die
    /// Session schon wieder genommen — kein Fehler des Kopfhörers.
    static let verlorenGrund = "verloren"

    /// Die Optionen der `playAndRecord`-Vorgaben des SDK 2.17.
    @MainActor static func sdkOptionen() -> AVAudioSession.CategoryOptions {
        var o: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay]
        if AudioManager.shared.isSpeakerOutputPreferred { o.insert(.defaultToSpeaker) }
        return o
    }
}
