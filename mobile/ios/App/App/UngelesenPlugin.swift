import Capacitor
import WidgetKit

/// Die Zahl ungelesener Nachrichten für das Widget „Ungelesen“ (Roadmap
/// Punkt 45). Die Web-App rechnet sie (dieselbe Zahl wie die Plakette am
/// Symbol, Punkt 17) und reicht sie hier herein (`platform/ungelesenWidget.ts`);
/// die Hülle legt sie in den gemeinsamen Container (`UngelesenAblage`) und lässt
/// das Widget neu zeichnen.
///
/// **Warum ein eigenes Plugin und keine bestehende Stelle.** Die Plakette setzt
/// ein fremdes Paket (`@capawesome/capacitor-badge`), dessen Swift-Code wir
/// nicht anfassen; mitlesen lässt sich dort nichts. Und eine neue Methode am
/// `SprachePlugin` würfe jeden älteren Bau ganz auf den Web-Sprachweg zurück
/// (die Weiche verlangt ALLE Methoden, `SPRACHE_METHODEN`). Ein eigenes Plugin
/// fehlt einem älteren Bau einfach — die Web-Seite fragt vorher
/// (`huelleKennt`) und tut dann nichts.
///
/// **Unabhängig von der Mitteilungs-Erlaubnis**, anders als die Plakette: ein
/// Widget braucht keine, und ohne Erlaubnis stünde am Symbol nichts, im Widget
/// aber die richtige Zahl.
@objc(UngelesenPlugin)
public class UngelesenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "UngelesenPlugin"
    public let jsName = "Ungelesen"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setzen", returnType: CAPPluginReturnPromise)
    ]

    @objc func setzen(_ call: CAPPluginCall) {
        let anzahl = call.getInt("anzahl") ?? 0
        DispatchQueue.main.async {
            Ungelesen.ablegen(anzahl)
            call.resolve()
        }
    }
}

/// Die Seite, die auch der `AppDelegate` ruft (`beimVerlassen`). Nur auf dem
/// Hauptthread.
enum Ungelesen {
    /// Hat die Web-App in diesem Lauf schon eine Zahl abgelegt? Erst dann darf
    /// das Verlassen der App den Zeitpunkt bestätigen — vorher läge im
    /// Container noch die Zahl eines früheren Laufs, womöglich eines anderen
    /// Kontos.
    private static var abgelegt = false

    static func ablegen(_ anzahl: Int) {
        abgelegt = true
        // **Neu zeichnen nur, wenn sich die Zahl ändert.** Gerufen wird bei
        // jeder Rückkehr in den Vordergrund, und WidgetKit teilt jedem Widget
        // ein Tageskontingent an Neuzeichnungen zu (laut Apple zählen sie
        // nicht, solange die App vorn ist — nicht gemessen).
        if UngelesenAblage.schreiben(anzahl) { neuZeichnen() }
    }

    /// Die App geht in den Hintergrund (`applicationWillResignActive`): bis
    /// jetzt kannte sie die Zahl, und genau das soll der Zeitpunkt im Widget
    /// sagen. Danach weiss sie nichts mehr — Pushes bei geschlossener App
    /// setzen nur die Plakette am Symbol.
    static func beimVerlassen() {
        guard abgelegt else { return }
        UngelesenAblage.bestaetigen()
        neuZeichnen()
    }

    private static func neuZeichnen() {
        WidgetCenter.shared.reloadTimelines(ofKind: UngelesenAblage.widgetArt)
    }
}
