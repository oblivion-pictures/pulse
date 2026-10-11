import AVFoundation
import LiveKit

/// Der Delegat-Teil von `SpracheRaum` — worauf der LiveKit-Raum hört.
///
/// Eigene Datei wegen der Grössen-Policy (`PLAN.md` §12.1), abgetrennt aus
/// `SpracheRaumZustand.swift`; was die Haken melden, baut jene Datei.

// MARK: - RoomDelegate

/// **Die Rufe kommen NICHT vom Hauptthread** (so sagt es LiveKits eigene
/// Dokumentation). Hier wird deshalb nur Zustand eingesammelt und über die
/// Brücke geschickt; wer Ansichten anfasst, muss selbst auf den Hauptthread
/// wechseln — die native Kanalansicht tut das nicht von hier aus, sondern
/// beobachtet `Room` selbst als `ObservableObject` (SwiftUI liefert die
/// Änderungen dann auf dem Hauptthread, s. `SpracheAnsicht.swift`).
///
/// **Jeder Haken prüft zuerst, ob `room` noch der laufende Raum ist.** Der
/// Delegat ist für ALLE Räume dieselbe Instanz, und die Ereignisse eines
/// gerade verlassenen Raums kommen verspätet (über LiveKits eigene
/// Warteschlange). Ohne den Wächter meldete der alte Raum nach einem
/// Kanalwechsel sein „getrennt" — an eine Oberfläche, die schon im neuen
/// Kanal sitzt. Der Web-Weg hat denselben Wächter (`_active()` in
/// `raumEreignisse.ts::raumVerdrahten`).
extension SpracheRaum: RoomDelegate {
    func room(_ room: Room, didUpdateConnectionState state: ConnectionState,
              from alt: ConnectionState) {
        NSLog("[PulseSprache] Verbindung %@ → %@", "\(alt)", "\(state)")
        guard room === raum else { return }
        melden("verbindung", ["zustand": Self.verbindungsName(state)])
        if state == .connected { schickeTeilnehmer() }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        NSLog("[PulseSprache] getrennt: %@", error?.localizedDescription ?? "ohne Fehler")
        guard room === raum else { return }
        // Von aussen getrennt (Netz, Server, Rauswurf): die Hülle räumt den
        // Raum selbst ab, auch die Ansicht (`raumAbgerissen`) — die Oberfläche
        // kann gerade eingefroren sein und erst später davon erfahren.
        raumAbgerissen(room)
        melden("verbindung", ["zustand": "disconnected",
                              "fehler": error?.localizedDescription ?? NSNull()])
    }

    func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) {
        NSLog("[PulseSprache] Verbinden fehlgeschlagen: %@",
              error?.localizedDescription ?? "unbekannt")
        guard room === raum else { return }
        melden("verbindung", ["zustand": "disconnected",
                              "fehler": error?.localizedDescription ?? "unbekannt"])
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    // MARK: - Was sonst noch eine neue Liste verlangt
    //
    // **Alles, was ein Feld in `abbilden` ändern kann, MUSS hier durchlaufen**
    // — die Web-Kachel zeichnet allein aus dem `teilnehmer`-Ereignis. Am
    // 2026-10-10 fehlten diese Haken („ich klicke auf stumm und sehe das
    // Zeichen nicht"). Die native Ansicht braucht sie nicht: sie beobachtet
    // `Room` und `Participant` direkt.

    /// **Der wichtigste Haken für das Stumm-Zeichen, in BEIDE Richtungen:**
    /// `participant: Participant` meldet die eigene Spur (`mute()`/`unmute()`)
    /// ebenso wie die Stummschaltung eines Fremden (Signal des Servers).
    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication,
              didUpdateIsMuted isMuted: Bool) {
        guard room === raum else { return }
        schickeTeilnehmer()
        if participant is LocalParticipant { schickeEigenen() }
    }

    /// Verbindungsgüte — die Oberfläche zeigt sie je Teilnehmer an
    /// (`connectionQuality`), und ohne diesen Haken blieb sie auf dem Wert des
    /// Beitritts stehen, in der Regel `unknown`.
    func room(_ room: Room, participant: Participant,
              didUpdateConnectionQuality quality: ConnectionQuality) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    /// Namensänderung. Ändert zusätzlich die REIHENFOLGE der Liste, weil nach
    /// Namen sortiert wird — ein Grund mehr, die ganze Liste zu schicken statt
    /// Einzeländerungen.
    func room(_ room: Room, participant: Participant, didUpdateName name: String) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    /// Spuren kommen und gehen, ohne dass ein Teilnehmer kommt oder geht — eine
    /// eingeschaltete Kamera und eine beginnende Bildschirmfreigabe laufen
    /// genau hier durch.
    ///
    /// **Veröffentlichen und Abonnieren sind zwei Ereignisse, und beide
    /// zählen.** `cameraOn` liest die PUBLIKATION, die schon beim
    /// Veröffentlichen da ist; die Spur selbst (und damit ein Bild) kommt erst
    /// mit dem Abonnement. Wer nur das eine verdrahtet, hat entweder ein
    /// Zeichen ohne Bild oder ein Bild ohne Zeichen.
    func room(_ room: Room, participant: RemoteParticipant,
              didPublishTrack publication: RemoteTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didUnpublishTrack publication: RemoteTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
        // Jede neue Tonspur sofort auf ihren richtigen Wert (Taub, Regler je
        // Teilnehmer, Gesamt) — s. `SpracheRaumTaub.swift`.
        if let ton = publication.track as? RemoteAudioTrack {
            spurStellen(ton, kennung: participant.identity?.stringValue ?? "")
        }
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    /// Die EIGENE Kamera: veröffentlichen und zurücknehmen laufen hier durch.
    /// `kamera(_:)` schickt die Liste schon selbst — dieser Haken fängt die
    /// Fälle, in denen das SDK die Spur ohne unser Zutun abräumt (Kamera vom
    /// System entzogen, Spur gescheitert).
    func room(_ room: Room, participant: LocalParticipant,
              didPublishTrack publication: LocalTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
        schickeEigenen()
    }

    func room(_ room: Room, participant: LocalParticipant,
              didUnpublishTrack publication: LocalTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
        schickeEigenen()
    }

    /// **Nur die Kippkante, nicht der Pegel.** Der Pegel ändert sich mehrmals
    /// pro Sekunde je Teilnehmer; über eine serielle Brücke geschickt wäre das
    /// genau die Last, die am 2026-10-10 die App angehalten hat. Wer ihn
    /// braucht, zeichnet ihn nativ — das tut `SpracheKachel`.
    func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        guard room === raum else { return }
        melden("sprechen", [
            "sprechen": participants.compactMap { $0.identity?.stringValue }
        ])
    }
}
