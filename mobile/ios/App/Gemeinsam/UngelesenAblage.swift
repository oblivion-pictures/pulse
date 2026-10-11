import Foundation

/// Die Zahl für das Widget „Ungelesen“ (Roadmap Punkt 45) im gemeinsamen
/// Container — die App schreibt (`UngelesenPlugin`), das Widget liest.
///
/// **Es ist dieselbe Zahl wie am App-Symbol**: ungelesene NACHRICHTEN der
/// privaten Gespräche (Punkt 17, `navigation/abzeichen.svelte.ts`), nicht die
/// Zahl der Gespräche. Gerechnet wird sie im Web; die Hülle reicht sie nur
/// durch.
///
/// **Nur die Zahl, nie ein Name oder ein Inhalt.** Der Container ist nicht
/// verschlüsselt, die Nachrichten sind es. Ob Namen der letzten
/// Gesprächspartner hierher dürften, ist eine offene Produktfrage (Roadmap
/// Punkt 45) — gebaut ist die Variante ohne.
///
/// **Die Zahl veraltet, solange die App zu ist, und das Widget sagt es.** Ein
/// Push bei geschlossener App setzt die Plakette am Symbol (`aps.badge`), aber
/// er weckt keinen Code von uns — das Widget erfährt davon erst, wenn die App
/// wieder läuft. Deshalb steht der Zeitpunkt dabei (`zeit`), zu dem die App
/// die Zahl zuletzt kannte.
enum UngelesenAblage {
    /// Die `kind` des Widgets. App und Erweiterung müssen dieselbe nennen,
    /// sonst lädt `reloadTimelines(ofKind:)` still nichts neu.
    static let widgetArt = "Ungelesen"

    private static let schluesselAnzahl = "ungelesen.anzahl"
    private static let schluesselZeit = "ungelesen.zeit"

    struct Stand: Equatable {
        var anzahl: Int
        /// `nil`, solange die App noch nie eine Zahl abgelegt hat.
        var zeit: Date?
    }

    /// `nil` ohne Entitlement (am Gerät etwa, solange das Profil die Gruppe
    /// nicht trägt) — dann zeigt das Widget den leeren Stand, statt zu raten.
    private static var speicher: UserDefaults? {
        AppGruppe.container == nil ? nil : UserDefaults(suiteName: AppGruppe.kennung)
    }

    /// Legt die Zahl ab und stempelt die Zeit. `true`, wenn sich die Zahl
    /// geändert hat — nur dann muss das Widget sofort neu zeichnen.
    @discardableResult
    static func schreiben(_ anzahl: Int, jetzt: Date = Date()) -> Bool {
        guard let s = speicher else { return false }
        let neu = max(0, anzahl)
        let alt = s.object(forKey: schluesselAnzahl) as? Int
        s.set(neu, forKey: schluesselAnzahl)
        s.set(jetzt, forKey: schluesselZeit)
        return alt != neu
    }

    /// Nur die Zeit nachziehen: die App kannte die Zahl bis eben, und sie hat
    /// sich nicht geändert (beim Verlassen der App, s. `AppDelegate`).
    static func bestaetigen(jetzt: Date = Date()) {
        guard let s = speicher, s.object(forKey: schluesselAnzahl) != nil else { return }
        s.set(jetzt, forKey: schluesselZeit)
    }

    static func lesen() -> Stand {
        guard let s = speicher else { return Stand(anzahl: 0, zeit: nil) }
        return Stand(
            anzahl: max(0, s.integer(forKey: schluesselAnzahl)),
            zeit: s.object(forKey: schluesselZeit) as? Date)
    }
}
