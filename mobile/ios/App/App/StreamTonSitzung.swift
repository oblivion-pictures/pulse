import AVFoundation
import LiveKit

/// **Wie der native Stream-Ton zur Audio-Session kommt — ohne sie je selbst
/// einzustellen.**
///
/// Die Session gehört LiveKit (`AudioSessionEngineObserver`), auch ohne
/// Sprachkanal. Der Stream-Ton meldet bei LiveKit eine Anforderung „nur
/// Wiedergabe" an (`acquireSessionRequirement(.playbackOnly)`, öffentliche
/// API, dasselbe Muster wie LiveKits eigener `SoundPlayer`). Daraus folgt:
///
/// - **Ohne Sprachkanal** stellt LiveKit `.playback` ein und aktiviert. Die
///   Kategorie folgt dem Stummschalter nicht und spielt dank Hintergrund-Audio
///   bei gesperrtem Gerät weiter.
/// - **Mit Sprachkanal** bleibt es bei `.playAndRecord` und dem Modus des
///   Kanals (`selectConfiguration` hängt an Aufnahme/`hasRecorded`, nicht an
///   der Wiedergabe). LiveKit ruft dabei `setCategory` mit denselben Werten —
///   wie bei jedem seiner eigenen Stumm-Wechsel.
/// - **Verlässt man den Kanal, deaktiviert LiveKit die Session NICHT**,
///   solange die Anforderung steht — sonst scheiterte `setActive(false)` an der
///   laufenden Stream-Maschine („busy"), LiveKit rollte seine Buchführung
///   zurück, und der nächste Beitritt sähe keinen Übergang (Kette K2 der
///   Befundakte vom 2026-10-17).
///
/// **Der Preis, und warum es `automatikAus`/`automatikAn` gibt.** Die Hülle
/// heilt eine kaputte Kette, indem sie LiveKit wieder bei „nichts aktiv"
/// anfangen lässt (`SpracheRaum.maschineNeu`, CallKit-Rückgabe): die nächste
/// Anforderung aktiviert die Session dann sicher. Eine dauerhaft gehaltene
/// Anforderung nähme diesen Übergang weg. Deshalb lässt der Stream-Ton sie an
/// genau diesen Stellen los, SOLANGE DIE AUTOMATIK AUS IST (dann fasst LiveKit
/// die Session nicht an — `configureIfNeeded` kehrt sofort zurück), und holt
/// sie zurück, wenn Automatik und Maschine wieder frei sind. Wer zuerst kommt,
/// LiveKits Maschine oder der Stream-Ton, macht den Übergang und aktiviert.
final class StreamTonSitzung: @unchecked Sendable {
    static let geteilt = StreamTonSitzung()

    private let sperre = NSLock()
    private var nutzer = 0
    private var anforderung: SessionRequirementHandle?
    /// Ausgesetzt für die Dauer einer Übergabe (`automatikAus`).
    private var ausgesetzt = false
    /// Wer bei einem Wiederanlauf gefragt wird (die laufenden Geräte).
    var wiederanlauf: ((String) -> Void)?

    /// Ein Gerät will spielen. `false`, wenn LiveKit die Session nicht
    /// einrichten konnte — das Gerät bleibt dann unterbrochen.
    func anmelden() -> Bool {
        sperre.lock()
        defer { sperre.unlock() }
        nutzer += 1
        if anforderung == nil, !ausgesetzt {
            do {
                anforderung = try AudioManager.shared.acquireSessionRequirement(.playbackOnly)
            } catch {
                nutzer -= 1
                melden("streamton_session_fehler", ["fehler": "\(error)"])
                return false
            }
        }
        return true
    }

    /// Ein Gerät steht (seine Maschine ist schon angehalten).
    func abmelden() {
        sperre.lock()
        nutzer = max(0, nutzer - 1)
        let los = nutzer == 0 ? anforderung : nil
        if nutzer == 0 { anforderung = nil }
        sperre.unlock()
        loslassen(los)
    }

    /// Unmittelbar NACH `isAutomaticConfigurationEnabled = false`.
    func automatikAus() {
        sperre.lock()
        ausgesetzt = true
        let los = anforderung
        anforderung = nil
        sperre.unlock()
        loslassen(los)
    }

    /// Nachdem Automatik und Maschine wieder frei sind. Hält jemand den Ton,
    /// wird die Anforderung neu gestellt (das ist der Übergang „nichts →
    /// aktiv"), danach laufen unterbrochene Geräte wieder an.
    func automatikAn(grund: String) {
        sperre.lock()
        ausgesetzt = false
        var neu = false
        if nutzer > 0, anforderung == nil {
            anforderung = try? AudioManager.shared.acquireSessionRequirement(.playbackOnly)
            neu = anforderung != nil
            if !neu { melden("streamton_session_fehler", ["grund": grund]) }
        }
        let laeuft = nutzer > 0
        sperre.unlock()
        if neu { melden("streamton_session_neu", ["grund": grund]) }
        if laeuft { wiederanlauf?(grund) }
    }

    /// Scheitert das Loslassen (LiveKit konnte nicht deaktivieren), hält die
    /// Buchführung die Anforderung weiter — die Session bleibt dann aktiv, was
    /// harmlos ist; gemeldet wird es trotzdem.
    private func loslassen(_ h: SessionRequirementHandle?) {
        guard let h else { return }
        do {
            try h.release()
        } catch {
            melden("streamton_session_loslassen_fehler", ["fehler": "\(error)"])
        }
    }

    private func melden(_ art: String, _ extra: [String: Any]) {
        SpracheRaum.geteilt.diagMelden(art, extra)
    }

    // MARK: - Echo-Lage

    /// **Hört das eigene Mikrofon den Stream-Ton mit?** Der native Stream-Ton
    /// liegt in KEINER Echo-Referenz: nicht in der von WebRTCs Software-AEC
    /// (die sieht nur die Wiedergabe ihrer eigenen Fabrik), und dass Apples
    /// VPIO „other audio" aus dem Mikrofon zieht, sagt Apple nirgends (es
    /// duckt ihn nur — LiveKit-Vorgabe `.min`, fest). Am eingebauten
    /// Lautsprecher, ein paar Zentimeter vom unteren Mikrofon, hörte der Kanal
    /// den Stream deshalb über das Telefon mit. Mit Hörmuschel ist der Weg
    /// leise, mit Kopfhörern weg.
    ///
    /// „Offen" heisst: ein nativer Raum (Kanal oder Anruf) veröffentlicht ein
    /// nicht stummes Mikrofon.
    static func echoLage() -> Bool {
        let route = AVAudioSession.sharedInstance().currentRoute.outputs
        guard route.contains(where: { $0.portType == .builtInSpeaker }) else { return false }
        let sprache = SpracheRaum.geteilt
        if let r = sprache.raum, !sprache.anrufPausiert,
           r.localParticipant.isMicrophoneEnabled() { return true }
        if let r = AnrufRaum.geteilt.raum, r.localParticipant.isMicrophoneEnabled() { return true }
        return false
    }
}
