import Foundation

/// Der gemeinsame Container der App und ihrer Erweiterungen (App Group).
///
/// **Ein allgemeiner Name, mit Absicht.** Zwei Erweiterungen teilen ihn: die
/// Teilen-Erweiterung legt hier Pakete ab (Punkt 41 der iOS-Liste), das Widget
/// „Ungelesen“ liest hier seine Zahl (Punkt 45, `UngelesenAblage`). Eine App
/// Group lässt sich nachträglich nicht umbenennen, ohne dass alle Profile neu
/// entstehen; wer sie `…share` genannt hätte, hätte sie fürs Widget ersetzen
/// müssen. Die Live Activity (Punkt 28) braucht den Container NICHT — ihren
/// Stand trägt ActivityKit von der App zur Erweiterung.
///
/// Die Kennung steht ein weiteres Mal in jeder `.entitlements`-Datei
/// (`App/App.entitlements`, `ShareExtension/ShareExtension.entitlements`,
/// `WidgetExtension/WidgetExtension.entitlements`) — das ist die Stelle, die
/// iOS liest. Wer sie ändert, zieht alle vier mit.
enum AppGruppe {
    static let kennung = "group.com.howispulse.app"

    /// `nil`, wenn dem laufenden Bau das Entitlement fehlt — am Gerät etwa
    /// dann, wenn das Profil die Gruppe noch nicht trägt. Jeder Aufrufer muss
    /// das als „hier gibt es nichts“ behandeln, nicht als Absturzgrund.
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: kennung)
    }
}
