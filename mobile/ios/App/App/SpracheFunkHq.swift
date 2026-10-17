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
/// sie abschaltbar (`wunsch`, Spracheinstellungen).
///
/// **Der Weg durch das SDK:** Verarbeitung `.software` (dieselbe wie „Volle
/// Tonqualität", `volleVerarbeitung`) → das SDK erwartet kein VPIO mehr und
/// wählt von selbst den Modus `.default` (`selectConfiguration`, die
/// `…Media`-Vorgaben) → hier kommt nur die eine Option dazu. Am Lautsprecher,
/// am Kabel und mit Kopfhörern ohne HQ bleibt alles wie heute (VPIO).
///
/// **Warum ein Maschinen-Beobachter und nicht `sessionConfiguration`:** die
/// Eigenschaft wird im SDK 2.17 gespeichert und nirgends gelesen (`grep`
/// über `Sources/` findet nur ihre Deklaration). `set(engineObservers:)` ist
/// der Weg, den das SDK selbst nennt; wir hängen uns HINTER seinen
/// Session-Beobachter, der vorher Kategorie und Modus gesetzt hat.
final class SpracheFunkHq: @unchecked Sendable {
    static let geteilt = SpracheFunkHq()

    private let sperre = NSLock()
    private var _wunsch = true
    private var _optionGewollt = false
    private var eingehaengt = false
    /// Für diesen Raum aufgegeben: die Option war gesetzt, das Mikrofon des
    /// Kopfhörers lief trotzdem nicht in HQ. Verhindert ein Pendeln. Nur in
    /// der Befehlskette des Raums angefasst.
    var gescheitert = false
    /// Zuletzt gemeldete Route — eine Diagnose-Zeile nur bei Wechsel.
    var letzteArt = ""

    /// Will der Nutzer den HQ-Weg? Vorgabe an; gesetzt vom Web.
    var wunsch: Bool {
        get { sperre.withLock { _wunsch } }
        set { sperre.withLock { _wunsch = newValue } }
    }

    /// Soll die Option an der Session stehen? Gelesen auch vom Faden der
    /// Audio-Maschine, deshalb hinter der Sperre.
    var optionGewollt: Bool {
        get { sperre.withLock { _optionGewollt } }
        set { sperre.withLock { _optionGewollt = newValue } }
    }

    func einhaengenFallsNoetig() {
        let neu = sperre.withLock { () -> Bool in
            defer { eingehaengt = true }
            return !eingehaengt
        }
        guard neu else { return }
        let am = AudioManager.shared
        am.set(engineObservers: [am.audioSession, FunkHqMaschine(), am.mixer])
    }

    func raumWeg() {
        optionGewollt = false
        gescheitert = false
        letzteArt = ""
    }

    /// Die Option setzen oder nehmen, wie `optionGewollt` es sagt — nur an
    /// einer `.playAndRecord`-Session, und gesetzt nur im Modus `.default`.
    /// Ohne Sperre gegen das SDK: setzt es gleichzeitig seine Vorgabe, kommt
    /// danach ein Routenwechsel, und der Abgleich setzt sie wieder.
    static func optionDurchsetzen(_ grund: String) {
        guard #available(iOS 26.0, *) else { return }
        let s = AVAudioSession.sharedInstance()
        let soll = geteilt.optionGewollt
        guard s.category == .playAndRecord,
              soll != s.categoryOptions.contains(.bluetoothHighQualityRecording),
              !soll || s.mode == .default,
              AudioManager.shared.audioSession.isAutomaticConfigurationEnabled
        else { return }
        var optionen = s.categoryOptions
        if soll { optionen.insert(.bluetoothHighQualityRecording) } else {
            optionen.remove(.bluetoothHighQualityRecording)
        }
        do {
            try s.setCategory(s.category, mode: s.mode, options: optionen)
            NSLog("[PulseSprache] FunkHq Option %@ (%@)", soll ? "an" : "aus", grund)
        } catch {
            NSLog("[PulseSprache] FunkHq Option FEHLER (%@): %@", grund, error.localizedDescription)
        }
    }
}

/// Setzt die Option, bevor die Maschine mit Aufnahme anläuft — der
/// Session-Beobachter des SDK hat Kategorie und Modus da schon gesetzt. Ohne
/// das liefe sie nach jedem Neustart (Wächter, Stummschalten) erst auf HFP an
/// und wechselte Augenblicke später die Route.
private final class FunkHqMaschine: AudioEngineObserver, @unchecked Sendable {
    private let sperre = NSLock()
    private var _next: (any AudioEngineObserver)?
    var next: (any AudioEngineObserver)? {
        get { sperre.withLock { _next } }
        set { sperre.withLock { _next = newValue } }
    }

    func engineWillEnable(_ engine: AVAudioEngine, isPlayoutEnabled: Bool,
                          isRecordingEnabled: Bool) -> Int {
        if isRecordingEnabled, !engine.isInManualRenderingMode {
            SpracheFunkHq.optionDurchsetzen("maschine")
        }
        return next?.engineWillEnable(engine, isPlayoutEnabled: isPlayoutEnabled,
                                      isRecordingEnabled: isRecordingEnabled) ?? 0
    }
}
