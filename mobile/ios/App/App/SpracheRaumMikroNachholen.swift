import AVFoundation
import Foundation
import LiveKit

/// Ein beim Beitritt gescheitertes Mikrofon später nachholen — und unter
/// CarPlay die Aufnahme vor dem Verbinden vorwärmen.
///
/// **Was die Berichte aus dem Auto belegen (2026-10-25, ausgewertet am
/// 2026-11-05):** Das Mikrofon nimmt auf. Der Diagnose-Build zählte die
/// Mikrofon-Puffer am selben Haken, an dem das SDK auf den ersten wartet: der
/// erste kam 2,6 s nach Beitritt, danach laufend weitere. `setMicrophone`
/// warf trotzdem `timedOut` (LiveKit 101), genau 10 s nach diesem ersten
/// Puffer — das ist die Frist, in der das SDK 2.17 auf die Antwort des
/// Servers zur neuen Spur wartet (`SignalClient._addTrackCompleters`,
/// `defaultPublish`; die Puffer-Frist von 5 s kann es nicht gewesen sein).
/// Danach „Server ping timed out“ (601) und `reconnecting`. Aus den
/// Ping-Fristen zurückgerechnet (LiveKit-Server: Ping alle 5 s, Ausfall nach
/// 15 s, `pkg/rtc/participant.go`) kam die
/// letzte Antwort des Servers ungefähr dann, als die Audio-Maschine mit dem
/// Automikrofon startete und meldete, dass der Ausgang von 2 auf 1 Kanal
/// wechselte (das Auto schaltet in den Telefon-Modus). **Gefolgert, nicht
/// gemessen** — warum ab da nichts mehr ankommt, sagen die Berichte nicht.
/// Das iPhone hing am Mobilfunk, daneben war ein WLAN da (`en0`), bei
/// kabellosem CarPlay das des Autos.
///
/// **Daraus zwei Regeln:**
/// 1. **Unter CarPlay die Aufnahme vor dem Verbinden starten**
///    (`carPlayVorwaermen`): der Wechsel des Autos in den Telefon-Modus fällt
///    dann vor die Signalverbindung, nicht mitten in das erste Veröffentlichen.
///    Ob das trägt, ist offen; der Beitrittsbericht trägt `vorgewaermt`.
/// 2. **Das Nachholen wartet auf eine Verbindung, statt die Maschine neu zu
///    bauen.** Der Versuchsaufbau vom 2026-10-25 baute die Maschine vor jedem
///    weiteren Versuch neu und verstellte Lautsprecher-Vorzug, Apples
///    Sprachverarbeitung und Mikrofonwahl. Beides schadete: nach dem Neubau
///    lief der Ton über den iPhone-Lautsprecher statt über das Auto (zwei
///    Berichte), und erst danach kamen die „-3001“-Fehler der Maschine, die
///    damals dem Automikrofon zugeschrieben wurden. Und nach drei Versuchen in
///    17 s gab es auf — eine Verbindung, die sich danach fing, blieb ohne
///    Mikrofon. Jetzt: mehr Geduld, unter CarPlay kein Neubau, und jedes
///    Wiederverbinden des Raums stösst das Nachholen erneut an
///    (`SpracheRaumDelegate.swift`).
///
/// **Warum es das Nachholen überhaupt braucht.** Der Mikrofon-Wächter
/// (`SpracheMikroWache`) heilt nur ein Mikrofon, das schon veröffentlicht war:
/// nach einem gescheiterten Beitritt ist es nie eingeschaltet, und
/// `mikrofonFehler` schliesst den Fall ausdrücklich aus. Ohne Nachholen blieb
/// das Mikrofon bis zum nächsten Beitritt tot.
///
/// **Ohne Erlaubnis wird nichts nachgeholt** — dann ist das fehlende Mikrofon
/// die Wahl des Nutzers, und jeder Versuch scheiterte gleich wieder.
extension SpracheRaum {
    /// Wartezeiten vor den Versuchen, in Sekunden, zusammen gut zwei Minuten.
    /// Gesetzt, nicht gemessen: der erste gibt einem Routenwechsel Zeit, die
    /// späteren einer wackelnden Verbindung. Danach hört die Reihe auf — ein
    /// Versuch schaltet die Aufnahme jedes Mal neu, und im Auto heisst das ein
    /// Umschalten der Anlage. Kommt die Verbindung später wieder, beginnt eine
    /// neue Reihe (`nachholenNachWiederverbinden`).
    static let mikroNachholAbstaende: [UInt64] = [2, 5, 10, 20, 40, 60]

    /// Wie lange nach dem Vorwärmen gewartet wird, bevor verbunden wird. Gesetzt,
    /// nicht gemessen: den Zeitpunkt des Kanalwechsels hält der Bericht nicht
    /// fest, nur dass er vor dem Ende des Veröffentlichens kam
    /// (`konfigWechsel: 1`); der erste Mikrofon-Puffer kam 1,1 s nach dem Start
    /// der Aufnahme.
    static let vorwaermZeitNs: UInt64 = 2_000_000_000

    /// Zählt die Nachhol-Reihen; eine Reihe läuft nur, solange sie die jüngste
    /// ist. Statisch, weil eine Erweiterung keine gespeicherte
    /// Instanz-Eigenschaft tragen kann; es gibt nur den einen Raum.
    private static var nachholReihe = 0
    /// Ob DIESER Raum die Aufnahme vorgewärmt hat — der Modus gilt im SDK über
    /// Räume hinweg, bis er abgeschaltet wird (`vorwaermenBeenden`).
    private static var vorgewaermt = false

    /// Fehlertext, Bereich und Code für die Diagnose — `localizedDescription`
    /// allein sagt bei SDK-Fehlern oft nicht, welche Frist oder welcher Teil.
    static func fehlerFelder(_ error: Error) -> [String: Any] {
        let ns = error as NSError
        return ["fehler": error.localizedDescription, "fehlerBereich": ns.domain, "fehlerCode": ns.code]
    }

    /// Läuft Ton oder Mikrofon gerade über das Auto?
    static func carPlayAktiv() -> Bool {
        let route = AVAudioSession.sharedInstance().currentRoute
        return (route.inputs + route.outputs).contains { $0.portType == .carAudio }
    }

    // MARK: - Vorwärmen (CarPlay)

    /// Vor dem Verbinden (`beitreten`): unter CarPlay die Aufnahme starten und
    /// kurz warten, damit das Auto in den Telefon-Modus schaltet, bevor die
    /// Signalverbindung steht. Mit denselben Verarbeitungs-Optionen wie die
    /// Spur (`vpioVerarbeitung`, AGC aus), sonst schaltete die Maschine beim
    /// Veröffentlichen noch einmal um. `true`: vorgewärmt.
    func carPlayVorwaermen() async -> Bool {
        guard Self.carPlayAktiv(), Anrufverwaltung.mikrofonErlaubt(), !anrufPausiert else { return false }
        // VOR dem Einschalten setzen: das Abschalten des vorigen Raums läuft als
        // eigene Aufgabe (`vorwaermenBeenden`) und lässt einen neu vorgewärmten
        // Raum an diesem Merker in Ruhe.
        Self.vorgewaermt = true
        do {
            try await AudioManager.shared.setRecordingAlwaysPreparedMode(
                true, audioProcessingOptions: Self.vpioVerarbeitung)
        } catch {
            Self.vorgewaermt = false
            diagMelden("vorwaermen_fehler", Self.fehlerFelder(error))
            return false
        }
        try? await Task.sleep(nanoseconds: Self.vorwaermZeitNs)
        return true
    }

    /// Beim Verlassen des Raums (`raumLoesen`): das Vorwärmen wieder abschalten,
    /// sonst bliebe die Aufnahme über den Raum hinaus vorbereitet.
    static func vorwaermenBeenden() {
        guard vorgewaermt else { return }
        vorgewaermt = false
        Task {
            // Hat inzwischen der nächste Raum vorgewärmt (Kanalwechsel), bleibt es an.
            guard !Self.vorgewaermt else { return }
            do { try await AudioManager.shared.setRecordingAlwaysPreparedMode(false) } catch {
                NSLog("[PulseSprache] Vorwärmen abschalten gescheitert: %@", error.localizedDescription)
            }
            // Wärmte er genau WÄHREND des Abschaltens vor, hätte das Abschalten
            // ihn überholt: dann wieder an.
            if Self.vorgewaermt {
                try? await AudioManager.shared.setRecordingAlwaysPreparedMode(
                    true, audioProcessingOptions: Self.vpioVerarbeitung)
            }
        }
    }

    // MARK: - Nachholen

    /// Nach einem Beitritt ohne Mikrofon (`beitreten`). `s`: die Sitzung dieses
    /// Beitritts — ein späterer Raum wird nie angefasst.
    func mikrofonNachholen(sitzung s: Int) {
        guard Anrufverwaltung.mikrofonErlaubt() else { return }
        Self.nachholReihe += 1
        let reihe = Self.nachholReihe
        Task { [weak self] in
            for (i, abstand) in Self.mikroNachholAbstaende.enumerated() {
                try? await Task.sleep(nanoseconds: abstand * 1_000_000_000)
                guard reihe == Self.nachholReihe else { return }
                guard let self, let erfolg = await self.mikrofonNachholVersuch(sitzung: s, versuch: i + 1)
                else { return }
                if erfolg { return }
            }
        }
    }

    /// Der Raum ist wieder verbunden (`SpracheRaumDelegate.swift`): fehlt das
    /// Mikrofon noch, beginnt eine neue Reihe — die alte endet beim nächsten
    /// Schritt (`nachholReihe`).
    func nachholenNachWiederverbinden() {
        guard raum != nil, mikrofonFehler != nil else { return }
        mikrofonNachholen(sitzung: sitzung)
    }

    /// `true`: das Mikrofon läuft. `false`: erneut gescheitert. `nil`: nichts
    /// mehr zu tun (Raum weg oder ein anderer, Mikrofon schon da).
    private func mikrofonNachholVersuch(sitzung s: Int, versuch: Int) async -> Bool? {
        guard raum != nil, sitzung == s, mikrofonFehler != nil else { return nil }
        let auto = Self.carPlayAktiv()
        // Den Neubau der Maschine nur ohne Auto: unter CarPlay riss er den Ton
        // vom Auto weg auf den iPhone-Lautsprecher (s. Modulkopf).
        if versuch > 1, !auto { await maschineNeu(grund: "mikro_nachholen") }
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
                diagMelden("mikro_nachgeholt", ["versuch": versuch, "auto": auto])
                schickeEigenen()
                schickeTeilnehmer()
                return true
            }
        } catch {
            diagMelden("mikro_nachholen_fehler",
                       Self.fehlerFelder(error).merging(["versuch": versuch, "auto": auto]) { $1 })
            return false
        }
    }
}
