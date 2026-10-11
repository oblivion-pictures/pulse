import SwiftUI
import WidgetKit

/// Die Widget-Erweiterung von Pulse: das Widget „Ungelesen“ (Roadmap
/// Punkt 45) und die Live Activity „Im Sprachkanal“ (Punkt 28).
///
/// **Beides in EINER Erweiterung.** Eine Live Activity wird von einer
/// Widget-Erweiterung gezeichnet, ein Widget ebenso; zwei Erweiterungen
/// hiessen zwei App-IDs, zwei Profile und zwei Mal die Fähigkeit „App Groups“
/// im Portal — für nichts.
///
/// **Die Erweiterung rechnet nichts und weiss nichts über Konten.** Die Zahl
/// liest sie aus dem gemeinsamen Container (`UngelesenAblage`), den Stand der
/// Aktivität bekommt sie von ActivityKit; geschrieben wird beides von der App.
@main
struct PulseWidgets: WidgetBundle {
    var body: some Widget {
        UngelesenWidget()
        SpracheAktivitaetWidget()
    }
}

/// Die Farben der App (`SpracheFarben` in der App, hier nachgestellt: die
/// Erweiterung ist ein eigenes Programm und sieht den App-Code nicht).
enum WidgetFarben {
    static let marke = farbe(hell: (0.145, 0.388, 0.922), dunkel: (0.231, 0.510, 0.965))
    static let schlecht = farbe(hell: (0.863, 0.149, 0.149), dunkel: (0.937, 0.267, 0.267))
    /// Das Schild der Admin-Stummschaltung (`amber-400`, wie im Web).
    static let schild = Color(red: 0.984, green: 0.749, blue: 0.141)

    private static func farbe(hell: (CGFloat, CGFloat, CGFloat),
                              dunkel: (CGFloat, CGFloat, CGFloat)) -> Color {
        Color(UIColor { merkmale in
            let f = merkmale.userInterfaceStyle == .dark ? dunkel : hell
            return UIColor(red: f.0, green: f.1, blue: f.2, alpha: 1)
        })
    }
}
