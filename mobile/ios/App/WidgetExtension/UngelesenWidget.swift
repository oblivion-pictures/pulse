import SwiftUI
import WidgetKit

/// Widget „Ungelesen“ (Roadmap Punkt 45): die Zahl ungelesener Nachrichten in
/// privaten Gesprächen — dieselbe wie die Plakette am Symbol —, ein Tipp
/// öffnet Pulse im Bereich Chats.
///
/// **Nur die Zahl.** Keine Namen, keine Vorschau: der gemeinsame Container ist
/// unverschlüsselt, die Nachrichten sind es (Begründung an `UngelesenAblage`).
///
/// **Neu gezeichnet wird auf Anstoss der App**, nicht nach Zeitplan — die
/// Zeitleiste hat keinen Ablauf (`.never`). Einzige Ausnahme ist Mitternacht:
/// dann wechselt die Angabe des Zeitpunkts von der Uhrzeit aufs Datum.
struct UngelesenWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: UngelesenAblage.widgetArt, provider: UngelesenQuelle()) { eintrag in
            UngelesenAnsicht(eintrag: eintrag)
        }
        .configurationDisplayName("Ungelesen")
        .description("Ungelesene Nachrichten in deinen privaten Gesprächen.")
        .supportedFamilies([.systemSmall, .accessoryCircular])
    }
}

struct UngelesenEintrag: TimelineEntry {
    let date: Date
    let stand: UngelesenAblage.Stand
}

struct UngelesenQuelle: TimelineProvider {
    func placeholder(in context: Context) -> UngelesenEintrag {
        UngelesenEintrag(date: Date(), stand: .init(anzahl: 0, zeit: nil))
    }

    func getSnapshot(in context: Context, completion: @escaping (UngelesenEintrag) -> Void) {
        completion(UngelesenEintrag(date: Date(), stand: UngelesenAblage.lesen()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UngelesenEintrag>) -> Void) {
        let jetzt = Date()
        let stand = UngelesenAblage.lesen()
        var eintraege = [UngelesenEintrag(date: jetzt, stand: stand)]
        if let mitternacht = Calendar.current.nextDate(
            after: jetzt, matching: DateComponents(hour: 0, minute: 0), matchingPolicy: .nextTime) {
            eintraege.append(UngelesenEintrag(date: mitternacht, stand: stand))
        }
        completion(Timeline(entries: eintraege, policy: .never))
    }
}

struct UngelesenAnsicht: View {
    @Environment(\.widgetFamily) private var familie
    let eintrag: UngelesenEintrag

    /// Der Chats-Bereich. Über den Weg, den auch Universal Links nehmen
    /// (`appUrlOpen` → `platform/universalLinks.ts`, geprüft von
    /// `tiefenlink.zielPfad`) — kein eigenes URL-Schema, keine eigene Weiche.
    private static let ziel = URL(string: "https://howispulse.com/app/@me")!

    var body: some View {
        Group {
            if familie == .accessoryCircular { rund } else { klein }
        }
        .widgetURL(Self.ziel)
    }

    private var anzahl: Int { eintrag.stand.anzahl }

    private var klein: some View {
        VStack(alignment: .leading, spacing: 2) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.title3)
                .foregroundStyle(WidgetFarben.marke)
            Spacer(minLength: 0)
            Text(anzahl, format: .number)
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(unterzeile)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            if let zeit = eintrag.stand.zeit {
                standZeile(zeit)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .widgetGrund()
    }

    private var unterzeile: LocalizedStringKey {
        switch anzahl {
        case 0: return "Alles gelesen"
        case 1: return "ungelesene Nachricht"
        default: return "ungelesene Nachrichten"
        }
    }

    /// Wann die App die Zahl zuletzt kannte (s. `UngelesenAblage`): heute als
    /// Uhrzeit, sonst als Datum — eine Uhrzeit von gestern läse sich wie eine
    /// von heute.
    private func standZeile(_ zeit: Date) -> Text {
        let angabe = Calendar.current.isDate(zeit, inSameDayAs: eintrag.date)
            ? zeit.formatted(date: .omitted, time: .shortened)
            : zeit.formatted(date: .abbreviated, time: .omitted)
        return Text("Stand \(angabe)")
    }

    /// Als `Text` je Fall gebaut, nicht per `? :` — ein Ternary aus Literalen
    /// wird zum `String` und bliebe unübersetzt.
    private var rundBeschriftung: Text {
        anzahl == 1 ? Text("1 ungelesene Nachricht") : Text("\(anzahl) ungelesene Nachrichten")
    }

    private var rund: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "bubble.left.fill")
                    .font(.caption2)
                Text(anzahl, format: .number)
                    .font(.title3.weight(.bold))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
            }
            .padding(4)
        }
        .accessibilityLabel(rundBeschriftung)
        .widgetGrund(leer: true)
    }
}

extension View {
    /// Ab iOS 17 verlangt WidgetKit den Hintergrund über `containerBackground`
    /// (sonst zeigt das System statt des Widgets einen Hinweis) und setzt die
    /// Ränder selbst; darunter gibt es beides nicht.
    @ViewBuilder
    func widgetGrund(leer: Bool = false) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) {
                if leer { Color.clear } else { Color(.systemBackground) }
            }
        } else if leer {
            self
        } else {
            padding().background(Color(.systemBackground))
        }
    }
}
