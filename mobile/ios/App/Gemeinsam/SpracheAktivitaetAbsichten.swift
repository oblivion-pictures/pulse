import AppIntents
import Foundation

/// Die Knöpfe der Live Activity „Im Sprachkanal“ (Roadmap Punkt 28) — ab
/// iOS 17, darunter zeigt die Aktivität nur an.
///
/// **Sie laufen im Prozess der APP, nicht in der Erweiterung.** Das ist die
/// Zusage von `LiveActivityIntent` (Apple: das System führt sie im Prozess der
/// App aus und startet ihn im Hintergrund, falls er nicht läuft). Nur dort gibt
/// es den Raum, den sie steuern. Die Datei ist trotzdem in BEIDE Targets
/// übersetzt: die Erweiterung braucht den Typ, um den Knopf zu zeichnen.
///
/// **Warum über `SpracheAktivitaetSteuerung` und nicht direkt.** Die
/// Erweiterung kennt `SpracheRaum` nicht — er hängt an LiveKit und an
/// Capacitor. Die App hängt beim Start ihre Ausführung ein
/// (`SpracheLiveAktivitaet.einrichten`); in der Erweiterung bleibt die Stelle
/// leer, und dort läuft `perform` auch nie.
enum SpracheAktivitaetBefehl {
    /// Mikrofon zu (`true`) oder auf. **Der ZIELSTAND, kein Umschalten:** die
    /// Aktivität kann einen veralteten Stand zeigen (sie wird gedrosselt
    /// aktualisiert), und ein Umschalten auf Grund eines veralteten Bildes
    /// öffnete das Mikrofon, das man schliessen wollte.
    case stumm(Bool)
    case verlassen
}

enum SpracheAktivitaetSteuerung {
    /// Von der App beim Start gesetzt; in der Erweiterung `nil`.
    static var ausfuehren: ((SpracheAktivitaetBefehl) async -> Void)?

    static func weiterreichen(_ befehl: SpracheAktivitaetBefehl) async {
        guard let ausfuehren else {
            // Liefe `perform` doch einmal in der Erweiterung, täte der Knopf
            // nichts — dann soll das wenigstens im Gerätelog stehen.
            NSLog("[PulseAktivitaet] Knopf ohne App-Prozess — nichts ausgeführt")
            return
        }
        await ausfuehren(befehl)
    }
}

@available(iOS 17.0, *)
struct SpracheMikrofonAbsicht: LiveActivityIntent {
    static var title: LocalizedStringResource = "Mikrofon im Sprachkanal"
    /// Nicht in der Kurzbefehle-App: ohne laufenden Kanal hätte die Aktion
    /// nichts zu tun, und sie gehört an die Aktivität.
    static var isDiscoverable = false

    @Parameter(title: "Stumm")
    var stumm: Bool

    init() {}

    init(stumm: Bool) {
        self.stumm = stumm
    }

    func perform() async throws -> some IntentResult {
        await SpracheAktivitaetSteuerung.weiterreichen(.stumm(stumm))
        return .result()
    }
}

@available(iOS 17.0, *)
struct SpracheVerlassenAbsicht: LiveActivityIntent {
    static var title: LocalizedStringResource = "Sprachkanal verlassen"
    static var isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        await SpracheAktivitaetSteuerung.weiterreichen(.verlassen)
        return .result()
    }
}
