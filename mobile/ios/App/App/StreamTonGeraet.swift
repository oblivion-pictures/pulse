import AVFoundation
import LiveKitWebRTC

/// Das Tongerät EINER Übertragung: WebRTC liefert dekodierte PCM-Daten, eine
/// eigene kleine `AVAudioEngine` spielt sie ab.
///
/// **Warum ein eigenes Gerät und nicht LiveKits Maschine.** Die Wiedergabe
/// der LiveKit-Maschine ist fest mono (`audio_engine_device.mm`, Ausgabe mit
/// `channels:1`), und ein Knoten IN dieser Maschine risse bei einem
/// Formatfehler Aufnahme und Wiedergabe des Sprachkanals mit — genau die
/// Mikrofon-Gefahr, gegen die die Hülle seit Wochen baut. Ein eigenes
/// `RTCAudioDevice` für eine eigene WebRTC-Fabrik ist öffentliche API
/// (`RTCAudioDevice.h`, `RTCPeerConnectionFactory.h`), und eine zweite
/// `AVAudioEngine` in derselben Session ist das Muster, das LiveKits eigener
/// `SoundPlayer` fährt. Befunde: `stream-stereo.md` (Arbeitsakte).
///
/// **Stereo.** Das Gerät meldet WebRTC 48 kHz und ZWEI Kanäle
/// (`objc_audio_device.mm`: `PlayoutParameters` liest `outputNumberOfChannels`,
/// 1 oder 2 erlaubt). Der Puffer verlangt damit stereo, ein Mono-Sender wird
/// vom Mischer verdoppelt. Ob am Ende zwei Kanäle HÖRBAR sind, entscheidet die
/// Route: die Maschine verbindet `mainMixerNode → outputNode` im Format der
/// Hardware und mischt bei einer Mono-Route selbst herunter.
///
/// **Fäden.** Die Methoden des Protokolls ruft WebRTC auf seinem Gerätefaden;
/// die Maschine wird nur auf `faden` angefasst; der Renderblock läuft auf dem
/// Echtzeit-Faden und liest dort nur `StreamTonPuffer` (keine Sperre, keine
/// Zuweisung).
final class StreamTonGeraet: NSObject, LKRTCAudioDevice, @unchecked Sendable {
    static let abtastrate: Double = 48_000
    static let kanaele = 2

    /// Wer wissen will, wie es steht (der Empfänger). Auf `faden`.
    var meldung: ((Phase, String) -> Void)?

    enum Phase: String { case aus, laeuft, unterbrochen }

    let puffer = StreamTonPuffer()
    let faden = DispatchQueue(label: "com.howispulse.streamton.geraet")
    private let sperre = NSLock()
    private var delegat: LKRTCAudioDeviceDelegate?
    private var wiedergabeGewollt = false
    private var initialisiert = false
    private var wiedergabeBereit = false
    // Ab hier nur auf `faden`.
    private var maschine: AVAudioEngine?
    private var quelle: AVAudioSourceNode?
    private var beobachter: [NSObjectProtocol] = []
    private(set) var phase: Phase = .aus
    /// Hält dieses Gerät gerade eine Anforderung an der Session?
    private var angemeldet = false

    // MARK: - LKRTCAudioDevice: Parameter

    var deviceInputSampleRate: Double { Self.abtastrate }
    var inputIOBufferDuration: TimeInterval { 0.01 }
    var inputNumberOfChannels: Int { 1 }
    var inputLatency: TimeInterval { 0 }
    var deviceOutputSampleRate: Double { Self.abtastrate }
    var outputIOBufferDuration: TimeInterval { 0.01 }
    var outputNumberOfChannels: Int { Self.kanaele }
    /// Für WebRTCs Verzögerungsschätzung (nur die Echo-Unterdrückung liest sie,
    /// und die nimmt hier nichts auf). Bewusst grob.
    var outputLatency: TimeInterval { AVAudioSession.sharedInstance().outputLatency }

    var isInitialized: Bool { sperre.withLock { initialisiert } }
    var isPlayoutInitialized: Bool { sperre.withLock { wiedergabeBereit } }
    var isPlaying: Bool { sperre.withLock { wiedergabeGewollt } }
    // Aufnahme gibt es nicht — Ton geht nur hinaus.
    var isRecordingInitialized: Bool { false }
    var isRecording: Bool { false }

    // MARK: - LKRTCAudioDevice: Lebenslauf

    func initialize(with delegate: LKRTCAudioDeviceDelegate) -> Bool {
        sperre.withLock {
            delegat = delegate
            initialisiert = true
        }
        return true
    }

    func terminateDevice() -> Bool {
        sperre.withLock {
            delegat = nil
            initialisiert = false
            wiedergabeBereit = false
            wiedergabeGewollt = false
        }
        faden.sync { anhalten(grund: "beendet") }
        return true
    }

    func initializePlayout() -> Bool {
        sperre.withLock { wiedergabeBereit = true }
        return true
    }

    /// WebRTC will spielen (der erste Empfangsstrom ist da). Gestartet wird
    /// auf `faden` — ein `AVAudioEngine.start()` darf WebRTCs Gerätefaden
    /// nicht aufhalten.
    func startPlayout() -> Bool {
        let block = sperre.withLock { () -> LKRTCAudioDeviceGetPlayoutDataBlock? in
            wiedergabeGewollt = true
            return delegat?.getPlayoutData
        }
        guard let block else { return false }
        puffer.holen = block
        faden.async { [weak self] in self?.starten(grund: "webrtc") }
        return true
    }

    func stopPlayout() -> Bool {
        sperre.withLock { wiedergabeGewollt = false }
        faden.async { [weak self] in self?.anhalten(grund: "webrtc") }
        return true
    }

    func initializeRecording() -> Bool { false }
    func startRecording() -> Bool { false }
    func stopRecording() -> Bool { false }

    // MARK: - Maschine (nur auf `faden`)

    /// Maschine bauen (falls nötig) und starten. Scheitert der Start, bleibt
    /// das Gerät `unterbrochen` und wartet auf den nächsten Anlass
    /// (`fortsetzen`) — ein eigener Wiederholungstakt würde gegen WebKit
    /// kämpfen, das unsere Session gerade hält (Messung in `iosTon.ts`).
    func starten(grund: String) {
        guard sperre.withLock({ wiedergabeGewollt }) else { return }
        if !angemeldet {
            guard StreamTonSitzung.geteilt.anmelden() else {
                setze(.unterbrochen, "session:\(grund)")
                return
            }
            angemeldet = true
        }
        let m = maschine ?? bauen()
        if m.isRunning {
            setze(.laeuft, grund)
            return
        }
        // Nach einem Stillstand darf WebRTC den Renderfaden wechseln sehen
        // (Vertrag in `RTCAudioDevice.h`).
        if phase != .aus, let d = sperre.withLock({ delegat }) {
            d.dispatchAsync { d.notifyAudioOutputInterrupted() }
        }
        do {
            m.prepare()
            try m.start()
            setze(.laeuft, grund)
        } catch {
            setze(.unterbrochen, "start:\(grund):\((error as NSError).code)")
        }
    }

    /// Stehen bleiben und die Session-Anforderung zurückgeben. Die Maschine
    /// steht VOR der Rückgabe — sonst deaktivierte LiveKit die Session unter
    /// laufender Ein-/Ausgabe (`setActive(false)` „busy", Rückroll K2).
    func anhalten(grund: String) {
        if let m = maschine { m.stop() }
        abbauen()
        if angemeldet {
            angemeldet = false
            StreamTonSitzung.geteilt.abmelden()
        }
        if phase != .aus { setze(.aus, grund) }
    }

    /// Nach einer Unterbrechung, einem Vordergrund-Wechsel oder auf Wunsch der
    /// Oberfläche: nur, wenn das Gerät spielen soll und gerade steht.
    func fortsetzen(grund: String) {
        faden.async { [weak self] in
            guard let self, phase == .unterbrochen || (maschine?.isRunning == false) else { return }
            starten(grund: grund)
        }
    }

    private func setze(_ neu: Phase, _ grund: String) {
        phase = neu
        meldung?(neu, grund)
    }

    private func bauen() -> AVAudioEngine {
        let m = AVAudioEngine()
        // Int16, verschachtelt, stereo, 48 kHz — genau das, was
        // `getPlayoutData` füllt. Die Maschine rechnet auf das Format der
        // Hardware um (Abtastrate und Kanalzahl).
        let quellFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: Self.abtastrate,
            channels: AVAudioChannelCount(Self.kanaele), interleaved: true)!
        let mischFormat = AVAudioFormat(
            standardFormatWithSampleRate: Self.abtastrate,
            channels: AVAudioChannelCount(Self.kanaele))!
        let p = puffer
        let q = AVAudioSourceNode(format: quellFormat) { stille, zeit, anzahl, ziel in
            p.rendern(stille: stille, zeit: zeit, anzahl: anzahl, ziel: ziel)
        }
        m.attach(q)
        m.connect(q, to: m.mainMixerNode, format: mischFormat)
        maschine = m
        quelle = q
        beobachten(m)
        let aus = m.outputNode.outputFormat(forBus: 0)
        puffer.ausgabeKanaele = Int(aus.channelCount)
        return m
    }

    private func abbauen() {
        for b in beobachter { NotificationCenter.default.removeObserver(b) }
        beobachter = []
        if let m = maschine, let q = quelle { m.detach(q) }
        maschine = nil
        quelle = nil
    }

    /// **Konfigurationswechsel = neu bauen**, nicht bloss neu starten: nach
    /// einem Kategorie- oder Routenwechsel (Kanal betreten/verlassen, Kopfhörer)
    /// kann sich das Hardware-Format geändert haben, und eine Verbindung im
    /// alten Format scheitert beim Start.
    private func beobachten(_ m: AVAudioEngine) {
        let nc = NotificationCenter.default
        beobachter.append(nc.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: m, queue: nil
        ) { [weak self] _ in
            self?.faden.async { self?.neuBauen(grund: "konfiguration") }
        })
        beobachter.append(nc.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
        ) { [weak self] n in
            let art = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            self?.faden.async { [weak self] in
                guard let self else { return }
                if art == AVAudioSession.InterruptionType.began.rawValue {
                    if phase == .laeuft { setze(.unterbrochen, "unterbrechung") }
                } else {
                    starten(grund: "unterbrechung_ende")
                }
            }
        })
        beobachter.append(nc.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil
        ) { [weak self] _ in
            self?.faden.async { self?.neuBauen(grund: "media_reset") }
        })
    }

    private func neuBauen(grund: String) {
        guard sperre.withLock({ wiedergabeGewollt }) else { return }
        maschine?.stop()
        abbauen()
        starten(grund: grund)
    }
}
