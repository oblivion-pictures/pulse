import LiveKit

/// Die Kamera im nativen Sprachkanal. Aus `SpracheRaum.swift` herausgelöst
/// (Grössen-Policy, `PLAN.md` §12.1); reine Verschiebung, Verhalten unverändert.
extension SpracheRaum {
    /// Kamera veröffentlichen oder zurücknehmen.
    ///
    /// **Ausschalten heisst ZURÜCKNEHMEN, nicht stummschalten** — der genaue
    /// Gegensatz zum Mikrofon, aus zwei Gründen, die beide schon im Web-Weg
    /// stehen (`eigeneKamera.ts::kameraSetzen`): ein nur gemutetes Video lässt
    /// den `track_unpublished`-Webhook aus (das CAM-Zeichen bliebe bei allen
    /// an), und die Kamera des Geräts liefe samt Leuchte weiter.
    func kamera(_ an: Bool) async throws {
        guard let r = raum else { return }
        if an {
            try await r.localParticipant.setCamera(
                enabled: true, captureOptions: CameraCaptureOptions(
                    position: kameraVorn ? .front : .back))
        } else if let pub = r.localParticipant.firstCameraPublication as? LocalTrackPublication {
            // `unpublish` stoppt die Spur mit (`stopLocalTrackOnUnpublish`,
            // Vorgabe des SDK) — damit geht die Kamera-Leuchte aus.
            try await r.localParticipant.unpublish(publication: pub)
        }
        schickeEigenen()
        schickeTeilnehmer()
    }

    /// Front- oder Rückkamera. Läuft die Kamera, wird der AUFNEHMER umgestellt
    /// statt neu veröffentlicht (die Gegenseite bemerkt keinen Abriss, wie
    /// `restartTrack` im Web); sonst wird nur der Wunsch gemerkt.
    func kameraSeite(front: Bool) async throws {
        kameraVorn = front
        if let spur = raum?.localParticipant.firstCameraPublication?.track as? LocalVideoTrack,
           let aufnehmer = spur.capturer as? CameraCapturer {
            _ = try await aufnehmer.set(cameraPosition: front ? .front : .back)
        }
        schickeEigenen()
    }
}
