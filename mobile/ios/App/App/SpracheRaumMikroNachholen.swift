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
/// **Ohne Erlaubnis wird nichts nachgeholt** — dann ist das fehlende Mikrofon
/// die Wahl des Nutzers, und jeder Versuch scheiterte gleich wieder.
extension SpracheRaum {
    /// Wartezeiten vor den Versuchen, in Sekunden. Gesetzt, nicht gemessen: der
    /// erste gibt einem Routenwechsel Zeit, die späteren fahren die Maschine
    /// vorher neu (`maschineNeu`, Stufe 2 des Wächters).
    static let mikroNachholAbstaende: [UInt64] = [2, 5, 10]

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
        if versuch > 1 { await maschineNeu(grund: "mikro_nachholen") }
        do {
            return try await nacheinander { [self] in
                guard let r = raum, sitzung == s, mikrofonFehler != nil else { return nil }
                // Während eines Anrufs bleibt das Mikrofon im Kanal zu; der
                // nächste Versuch fragt erneut.
                guard !anrufPausiert else { return false }
                try await r.localParticipant.setMicrophone(enabled: true)
                Self.agcAus()
                if !mikroWunsch { try await Self.stummSchalten(true, in: r) }
                mikrofonFehler = nil
                diagMelden("mikro_nachgeholt", ["versuch": versuch])
                schickeEigenen()
                schickeTeilnehmer()
                return true
            }
        } catch {
            diagMelden("mikro_nachholen_fehler", Self.fehlerFelder(error).merging(["versuch": versuch]) { $1 })
            return false
        }
    }
}
