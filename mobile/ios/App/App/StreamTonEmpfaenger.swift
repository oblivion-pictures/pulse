import AVFoundation
import LiveKitWebRTC

/// Der native Empfänger für den Ton EINER Übertragung (einer Kachel):
/// eigene WebRTC-Fabrik mit eigenem Tongerät (`StreamTonGeraet`), eine
/// PeerConnection mit genau einem Ton-Transceiver (`recvonly`), WHEP gegen
/// MediaMTX (`StreamTonWhep`). Das Bild bleibt in der WebView.
///
/// **Eine Fabrik je Empfänger, nicht eine für alle.** WebRTC mischt alle
/// Ströme einer Fabrik vor dem Gerät zusammen; je Kachel verzögern
/// (A/V-Ausgleich) oder absenken liesse sich dann nicht mehr. Zwei
/// gleichzeitige Übertragungen kosten so zwei Fabriken (je drei Fäden) —
/// tragbar, und ein Fehler in einem Empfänger berührt den anderen nicht.
///
/// **Kein eigener Wiederholungs-Takt.** Scheitert die Verbindung, meldet der
/// Empfänger `fehler`; die Oberfläche holt eine frische URL (das Lese-Token
/// lebt 10 min) und startet neu (`nativerStreamTon.ts`).
final class StreamTonEmpfaenger: NSObject, LKRTCPeerConnectionDelegate, @unchecked Sendable {
    enum Phase: String { case verbinde, spielt, unterbrochen, beendet, fehler }

    static let iceFrist: TimeInterval = 2
    static let maxVerzoegerungMs = 300

    let kennung: String
    /// Zustandsmeldung an die Verwaltung (beliebiger Faden).
    var meldung: ((StreamTonEmpfaenger, Phase, String) -> Void)?

    let geraet = StreamTonGeraet()
    private let sperre = NSLock()
    private var fabrik: LKRTCPeerConnectionFactory?
    private var pc: LKRTCPeerConnection?
    private var ressource: URL?
    private var verbunden = false
    private var beendet = false
    private var phase: Phase = .verbinde
    private var lautstaerke: Double = 1
    private var echoFaktor: Double = 1
    private var sammelnFertig: (() -> Void)?

    init(kennung: String) {
        self.kennung = kennung
        super.init()
        geraet.meldung = { [weak self] _, grund in self?.neuBewerten(grund) }
    }

    // MARK: - Aufbau

    func starten(url: URL) async throws {
        LKRTCInitializeSSL()
        let f = LKRTCPeerConnectionFactory(
            encoderFactory: LKRTCDefaultVideoEncoderFactory(),
            decoderFactory: LKRTCDefaultVideoDecoderFactory(),
            audioDevice: geraet)
        let konfig = LKRTCConfiguration()
        konfig.iceServers = [LKRTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
        konfig.sdpSemantics = .unifiedPlan
        konfig.bundlePolicy = .maxBundle
        konfig.rtcpMuxPolicy = .require
        konfig.continualGatheringPolicy = .gatherOnce
        let regeln = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let p = f.peerConnection(with: konfig, constraints: regeln, delegate: self) else {
            throw StreamTonWhep.Fehler(status: 0, text: "pc_fehlt")
        }
        let wie = LKRTCRtpTransceiverInit()
        wie.direction = .recvOnly
        p.addTransceiver(of: .audio, init: wie)
        sperre.withLock {
            fabrik = f
            pc = p
        }
        do {
            let angebot = try await angebotErstellen(p, regeln)
            let gemunged = LKRTCSessionDescription(type: .offer, sdp: StreamTonWhep.stereoErbitten(angebot.sdp))
            try await beschreiben(p, lokal: gemunged)
            await kandidatenAbwarten()
            let sdp = p.localDescription?.sdp ?? gemunged.sdp
            let (antwort, ort) = try await StreamTonWhep.anbieten(url, sdp: sdp)
            sperre.withLock { ressource = ort }
            if sperre.withLock({ beendet }) { throw StreamTonWhep.Fehler(status: 0, text: "abgebrochen") }
            try await beschreiben(p, entfernt: LKRTCSessionDescription(type: .answer, sdp: antwort))
            lautstaerkeAnwenden()
        } catch {
            await stoppen()
            throw error
        }
    }

    /// Abbauen: PeerConnection zu (WebRTC hält dann die Wiedergabe an, das
    /// Gerät gibt die Session-Anforderung zurück), DELETE, Fabrik weg.
    /// Wiederholbar.
    func stoppen() async {
        let (p, ort) = sperre.withLock { () -> (LKRTCPeerConnection?, URL?) in
            beendet = true
            defer { pc = nil; ressource = nil }
            return (pc, ressource)
        }
        p?.close()
        StreamTonWhep.beenden(ort)
        // Das Gerät steht spätestens jetzt (auch wenn WebRTC `stopPlayout`
        // nicht mehr ruft) — erst danach darf die Fabrik gehen.
        geraet.faden.sync { geraet.anhalten(grund: "stoppen") }
        sperre.withLock { fabrik = nil }
        setze(.beendet, "stoppen")
    }

    // MARK: - Steuerung

    func lautstaerkeSetzen(_ wert: Double) {
        sperre.withLock { lautstaerke = max(0, min(10, wert)) }
        lautstaerkeAnwenden()
    }

    func echoFaktorSetzen(_ wert: Double) {
        let geaendert = sperre.withLock { () -> Bool in
            defer { echoFaktor = wert }
            return echoFaktor != wert
        }
        if geaendert { lautstaerkeAnwenden() }
    }

    var echoGedaempft: Bool { sperre.withLock { echoFaktor < 1 } }

    func verzoegerungSetzen(ms: Int) {
        let begrenzt = max(0, min(Self.maxVerzoegerungMs, ms))
        geraet.puffer.zielVerzoegerung = begrenzt * Int(StreamTonGeraet.abtastrate) / 1000
    }

    /// Die Verstärkung sitzt im eigenen Renderblock, nicht an
    /// `LKRTCAudioSource.volume`: dort gleitet sie (kein Knacken beim
    /// Umschalten der Echo-Lage) und gilt sofort, auch während WebRTC gerade
    /// keine Pakete hat.
    private func lautstaerkeAnwenden() {
        let g = sperre.withLock { lautstaerke * echoFaktor }
        geraet.puffer.zielVerstaerkung = Float(g)
    }

    // MARK: - Zustand

    private func setze(_ neu: Phase, _ grund: String) {
        let alt = sperre.withLock { () -> Phase in
            defer { phase = neu }
            return phase
        }
        if alt != neu { meldung?(self, neu, grund) }
    }

    var phaseJetzt: Phase { sperre.withLock { phase } }

    /// Verbindung UND Maschine zusammen ergeben, was die Kachel zeigt.
    private func neuBewerten(_ grund: String) {
        let (ende, da) = sperre.withLock { (beendet, verbunden) }
        guard !ende else { return }
        guard da else { return setze(.verbinde, grund) }
        switch geraet.phase {
        case .laeuft: setze(.spielt, grund)
        case .unterbrochen: setze(.unterbrochen, grund)
        case .aus: setze(.verbinde, grund)
        }
    }

    // MARK: - Statistik

    /// Jitterpuffer, Pegel, Kanäle — für A/V-Ausgleich, Diagnose und Probe.
    /// Keine Kennungen, keine Adressen.
    func statistik() async -> [String: Any] {
        var aus: [String: Any] = [
            "verzoegerungMs": geraet.puffer.verzoegerungMs,
            "ausgabeMs": Int(AVAudioSessionLatenz.jetzt() * 1000),
            "hardwareKanaele": geraet.puffer.ausgabeKanaele,
            "phase": phaseJetzt.rawValue,
            "echoGedaempft": echoGedaempft
        ]
        let pegel = geraet.puffer.pegelAblesen()
        aus["pegelL"] = Double(pegel.l)
        aus["pegelR"] = Double(pegel.r)
        aus["frames"] = Double(pegel.frames)
        guard let p = sperre.withLock({ pc }) else { return aus }
        let bericht = await withCheckedContinuation { (fertig: CheckedContinuation<LKRTCStatisticsReport, Never>) in
            p.statistics { fertig.resume(returning: $0) }
        }
        for s in bericht.statistics.values {
            let w = s.values
            if s.type == "inbound-rtp", (w["kind"] as? String) == "audio" {
                let jb = (w["jitterBufferDelay"] as? NSNumber)?.doubleValue ?? 0
                let n = (w["jitterBufferEmittedCount"] as? NSNumber)?.doubleValue ?? 0
                aus["jitterMs"] = n > 0 ? jb / n * 1000 : 0
                // Roh, damit die Oberfläche über ein FENSTER mitteln kann —
                // der Mittelwert seit Beginn trägt den Anlauf (gemessen: 220 ms
                // in der ersten Sekunde, 100 ms nach zehn) ewig mit.
                aus["jbSumme"] = jb
                aus["jbAnzahl"] = n
                aus["pakete"] = (w["packetsReceived"] as? NSNumber)?.intValue ?? 0
                aus["verloren"] = (w["packetsLost"] as? NSNumber)?.intValue ?? 0
                aus["verdeckt"] = (w["concealedSamples"] as? NSNumber)?.intValue ?? 0
                aus["empfangen"] = (w["totalSamplesReceived"] as? NSNumber)?.intValue ?? 0
            } else if s.type == "codec", (w["mimeType"] as? String)?.lowercased() == "audio/opus" {
                aus["codecKanaele"] = (w["channels"] as? NSNumber)?.intValue ?? 0
                aus["fmtp"] = (w["sdpFmtpLine"] as? String) ?? ""
            }
        }
        return aus
    }

    // MARK: - Hilfen für den Handshake

    private func angebotErstellen(_ p: LKRTCPeerConnection,
                                  _ regeln: LKRTCMediaConstraints) async throws -> LKRTCSessionDescription {
        try await withCheckedThrowingContinuation { fertig in
            p.offer(for: regeln) { sdp, fehler in
                if let sdp { fertig.resume(returning: sdp) } else {
                    fertig.resume(throwing: fehler ?? StreamTonWhep.Fehler(status: 0, text: "angebot"))
                }
            }
        }
    }

    private func beschreiben(_ p: LKRTCPeerConnection, lokal: LKRTCSessionDescription? = nil,
                             entfernt: LKRTCSessionDescription? = nil) async throws {
        try await withCheckedThrowingContinuation { (fertig: CheckedContinuation<Void, Error>) in
            let ende: (Error?) -> Void = { fehler in
                if let fehler { fertig.resume(throwing: fehler) } else { fertig.resume() }
            }
            if let lokal { p.setLocalDescription(lokal, completionHandler: ende) }
            else if let entfernt { p.setRemoteDescription(entfernt, completionHandler: ende) }
        }
    }

    /// Wie `waitForIceGathering` in `whep.ts`: bis „complete", bis zum ersten
    /// srflx-Kandidaten (den braucht ein entfernter Server; der Rest sind
    /// LAN-Adressen) oder höchstens `iceFrist`.
    private func kandidatenAbwarten() async {
        await withCheckedContinuation { (fertig: CheckedContinuation<Void, Never>) in
            let einmal = Einmal { fertig.resume() }
            sperre.withLock { sammelnFertig = { einmal.ausloesen() } }
            if sperre.withLock({ pc?.iceGatheringState == .complete }) { einmal.ausloesen() }
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.iceFrist) { einmal.ausloesen() }
        }
        sperre.withLock { sammelnFertig = nil }
    }

    // MARK: - LKRTCPeerConnectionDelegate

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        switch newState {
        case .connected:
            sperre.withLock { verbunden = true }
            neuBewerten("verbunden")
        case .failed, .closed:
            sperre.withLock { verbunden = false }
            if !sperre.withLock({ beendet }) { setze(.fehler, "verbindung_\(newState.rawValue)") }
        case .disconnected:
            // Vorübergehend (WebRTC erholt sich meist) — erst nach einer Frist
            // ohne Rückkehr ist es ein Fehler.
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let self, !sperre.withLock({ self.beendet }),
                      peerConnection.connectionState == .disconnected else { return }
                sperre.withLock { self.verbunden = false }
                setze(.fehler, "verbindung_weg")
            }
        default:
            break
        }
    }

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {
        if newState == .complete { sperre.withLock { sammelnFertig }?() }
    }

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        if candidate.sdp.contains(" typ srflx") { sperre.withLock { sammelnFertig }?() }
    }

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {}
}

/// Ein Abschluss, der höchstens einmal läuft — für Fortsetzungen, die mehrere
/// Auslöser haben (Ereignis, Frist).
final class Einmal: @unchecked Sendable {
    private let sperre = NSLock()
    private var arbeit: (() -> Void)?
    init(_ arbeit: @escaping () -> Void) { self.arbeit = arbeit }
    func ausloesen() {
        let a = sperre.withLock { () -> (() -> Void)? in
            defer { arbeit = nil }
            return arbeit
        }
        a?()
    }
}

/// Wie lange der Ton von der Maschine bis zum Ohr braucht (Ausgabe-Latenz plus
/// ein Ein-/Ausgabe-Puffer) — für den A/V-Ausgleich.
enum AVAudioSessionLatenz {
    static func jetzt() -> TimeInterval {
        let s = AVAudioSession.sharedInstance()
        return s.outputLatency + s.ioBufferDuration
    }
}
