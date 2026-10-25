import AVFoundation
import Foundation
import LiveKit

/// Ein beim Beitritt gescheitertes Mikrofon später nachholen.
///
/// **Der Befund (2026-10-25, Diagnosebericht aus dem Auto mit CarPlay):** Der
/// Beitritt stand, die Session lief als `playAndRecord` mit Route und Eingang
/// `CarAudio`, die Audio-Maschine lief, Apples Sprachverarbeitung war an — und
/// trotzdem warf `setMicrophone(enabled: true)` nach gut 12 Sekunden. Während
/// des Starts meldete die Maschine einen Konfigurationswechsel (Ausgang 2 → 1
/// Kanal: das Umschalten auf das Autotelefon). Am Ende des Veröffentlichens
/// wartet das SDK höchstens 5 s auf den ersten Mikrofon-Puffer
/// (`LocalAudioTrack.startWaitingForFrames`); dass genau diese Frist riss,
/// passt zur Zeitlinie, ist aber nicht belegt — der Fehlertext fehlte im
/// Bericht und steht seitdem darin (`fehlerFelder`).
///
/// **Warum es das braucht.** Der Mikrofon-Wächter (`SpracheMikroWache`) heilt
/// nur ein Mikrofon, das schon veröffentlicht war: nach einem gescheiterten
/// Beitritt ist es nie eingeschaltet, und `mikrofonFehler` schliesst den Fall
/// ausdrücklich aus. Das Mikrofon blieb so bis zum nächsten Beitritt tot, und
/// ein Tipp auf „Mikrofon an“ lief in dieselbe Frist.
///
/// **Der zweite Bericht (Build 24.1, 13:34) zeigte, dass schlichtes Wiederholen
/// unter CarPlay nicht trägt:** Beitritt „Timed out“ (LiveKit 101), Versuch 1
/// „Server state mismatch“ (504 — der Server trennte, vermutlich hing die
/// erste Spur noch halb an ihm), Versuche 2 und 3 nach neu gebauter Maschine
/// „Audio engine returned error code: -3001“ (801). Die Maschine liefert mit
/// dem Automikrofon keinen Puffer und startet danach nicht mehr sauber.
/// **Warum, ist nicht geklärt** — weder Apple noch LiveKit dokumentieren es.
/// Deshalb probiert das Nachholen unter CarPlay je Versuch eine weitere
/// Einstellung (`carPlayVarianteSetzen`) und meldet, welche trug: ein
/// Versuchsaufbau, kein Endstand. Was nach einem Testlauf im Auto trägt, wird
/// zur festen Regel, der Rest geht wieder heraus.
///
/// **Ohne Erlaubnis wird nichts nachgeholt** — dann ist das fehlende Mikrofon
/// die Wahl des Nutzers, und jeder Versuch scheiterte gleich wieder.
extension SpracheRaum {
    /// Wartezeiten vor den Versuchen, in Sekunden. Gesetzt, nicht gemessen: der
    /// erste gibt einem Routenwechsel Zeit, die späteren fahren die Maschine
    /// vorher neu (`maschineNeu`, Stufe 2 des Wächters).
    static let mikroNachholAbstaende: [UInt64] = [2, 5, 10]

    /// Was ein CarPlay-Versuch verstellt hat, zum Zurückstellen beim Verlassen
    /// (`carPlayZuruecksetzen`). Statisch, weil eine Erweiterung keine
    /// gespeicherte Instanz-Eigenschaft tragen kann; es gibt nur den einen Raum.
    /// `eingangVorher` ist doppelt optional: das äussere `nil` heisst „nichts
    /// verstellt“, das innere „vorher war kein bevorzugter Eingang gesetzt“ —
    /// auch das muss beim Zurückstellen wieder gesetzt werden.
    private static var lautsprecherVorher: Bool?
    private static var vpioErlaubtVorher: Bool?
    private static var eingangVorher: AVAudioSessionPortDescription??

    /// Fehlertext, Bereich und Code für die Diagnose — `localizedDescription`
    /// allein sagt bei SDK-Fehlern oft nicht, welche Frist oder welcher Teil.
    static func fehlerFelder(_ error: Error) -> [String: Any] {
        let ns = error as NSError
        return ["fehler": error.localizedDescription, "fehlerBereich": ns.domain, "fehlerCode": ns.code]
    }

    /// Nach einem Beitritt ohne Mikrofon (`beitreten`). `s`: die Sitzung dieses
    /// Beitritts — ein späterer Raum wird nie angefasst.
    func mikrofonNachholen(sitzung s: Int) {
        guard Anrufverwaltung.mikrofonErlaubt() else { return }
        Task { [weak self] in
            for (i, abstand) in Self.mikroNachholAbstaende.enumerated() {
                try? await Task.sleep(nanoseconds: abstand * 1_000_000_000)
                guard let self, let erfolg = await self.mikrofonNachholVersuch(sitzung: s, versuch: i + 1)
                else { return }
                if erfolg { return }
            }
        }
    }

    /// `true`: das Mikrofon läuft. `false`: erneut gescheitert. `nil`: nichts
    /// mehr zu tun (Raum weg oder ein anderer, Mikrofon schon da).
    private func mikrofonNachholVersuch(sitzung s: Int, versuch: Int) async -> Bool? {
        guard raum != nil, sitzung == s, mikrofonFehler != nil else { return nil }
        let variante = Self.carPlayAktiv() ? Self.carPlayVarianteSetzen(stufe: versuch) : "gleich"
        if versuch > 1 { await maschineNeu(grund: "mikro_nachholen") }
        do {
            return try await nacheinander { [self] in
                guard let r = raum, sitzung == s, mikrofonFehler != nil else { return nil }
                // Während eines Anrufs bleibt das Mikrofon im Kanal zu, und eine
                // getrennte Verbindung baut der Raum erst wieder auf: der
                // nächste Versuch fragt erneut.
                guard !anrufPausiert, r.connectionState == .connected else { return false }
                // Eine vom gescheiterten Versuch übrige Spur zuerst abmelden —
                // sonst trennte der Server mit „Server state mismatch“
                // (zweiter Bericht, Versuch 1). Muster: `mikrofonspurNeu`.
                if let pub = r.localParticipant.audioTracks
                    .first(where: { $0.source == .microphone }) as? LocalTrackPublication {
                    try await r.localParticipant.unpublish(publication: pub)
                }
                try await r.localParticipant.setMicrophone(enabled: true)
                Self.agcAus()
                if !mikroWunsch { try await Self.stummSchalten(true, in: r) }
                mikrofonFehler = nil
                diagMelden("mikro_nachgeholt", ["versuch": versuch, "variante": variante])
                schickeEigenen()
                schickeTeilnehmer()
                return true
            }
        } catch {
            diagMelden("mikro_nachholen_fehler",
                       Self.fehlerFelder(error).merging(["versuch": versuch, "variante": variante]) { $1 })
            return false
        }
    }

    // MARK: - CarPlay-Varianten (Versuchsaufbau)

    /// Läuft Ton oder Mikrofon gerade über das Auto? Die Ausgänge zählen mit:
    /// nach Variante 3 kommt der Eingang vom iPhone, die Ausgabe bleibt im Auto.
    static func carPlayAktiv() -> Bool {
        let route = AVAudioSession.sharedInstance().currentRoute
        return (route.inputs + route.outputs).contains { $0.portType == .carAudio }
    }

    /// Je Versuch eine weitere Einstellung, die vorigen bleiben (aufbauend):
    ///
    /// 1. `sprachchat` — kein Lautsprecher-Vorzug, damit wählt das SDK den Modus
    ///    `.voiceChat` statt `.videoChat`. Ein Telefonat im Auto läuft so; mit
    ///    „Lautsprecher bevorzugt“ (Pulse-Vorgabe) lief der Kanal als Video-Chat.
    /// 2. `ohne_vpio` — Apples Sprachverarbeitung nicht zulassen; das SDK fällt
    ///    auf WebRTCs Software-Verarbeitung zurück
    ///    (`setPlatformVoiceProcessingAllowed`).
    /// 3. `iphone_mikro` — das eingebaute Mikrofon statt des Autos als
    ///    bevorzugter Eingang. Damit spricht man wenigstens, der Ton bleibt im
    ///    Auto (ungemessen, ob CarPlay das so zulässt).
    static func carPlayVarianteSetzen(stufe: Int) -> String {
        let am = AudioManager.shared
        switch stufe {
        case 1:
            if lautsprecherVorher == nil { lautsprecherVorher = am.isSpeakerOutputPreferred }
            am.isSpeakerOutputPreferred = false
            return "sprachchat"
        case 2:
            if vpioErlaubtVorher == nil { vpioErlaubtVorher = am.isPlatformVoiceProcessingAllowed }
            do { try am.setPlatformVoiceProcessingAllowed(false) } catch {
                NSLog("[PulseSprache] VPIO abschalten gescheitert: %@", error.localizedDescription)
            }
            return "sprachchat_ohne_vpio"
        default:
            let s = AVAudioSession.sharedInstance()
            if eingangVorher == nil { eingangVorher = .some(s.preferredInput) }
            if let mikro = s.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                do { try s.setPreferredInput(mikro) } catch {
                    NSLog("[PulseSprache] iPhone-Mikrofon wählen gescheitert: %@", error.localizedDescription)
                }
            }
            return "sprachchat_ohne_vpio_iphone_mikro"
        }
    }

    /// Beim Verlassen des Raums (`raumLoesen`): jede verstellte Einstellung
    /// zurück, damit nichts über das Auto hinaus hängen bleibt — der nächste
    /// Beitritt am Telefon soll wieder den Lautsprecher und Apples
    /// Sprachverarbeitung haben, und eine eigene Mikrofonwahl gilt wieder.
    static func carPlayZuruecksetzen() {
        let am = AudioManager.shared
        if let l = lautsprecherVorher { am.isSpeakerOutputPreferred = l }
        if let v = vpioErlaubtVorher { try? am.setPlatformVoiceProcessingAllowed(v) }
        if let e = eingangVorher { try? AVAudioSession.sharedInstance().setPreferredInput(e) }
        lautsprecherVorher = nil
        vpioErlaubtVorher = nil
        eingangVorher = nil
    }
}
