import Foundation

/// Der gemeinsame Container der App und ihrer Erweiterungen (App Group).
///
/// **Ein allgemeiner Name, mit Absicht.** Heute legt nur die Teilen-Erweiterung
/// hier etwas ab (Punkt 41 der iOS-Liste). Widgets und Live Activity (Punkte
/// 45 und 28) brauchen denselben Container, und eine App Group lässt sich
/// nachträglich nicht umbenennen, ohne dass beide Profile neu entstehen. Wer
/// sie hier `…share` genannt hätte, müsste sie für das erste Widget ersetzen.
///
/// Die Kennung steht ein zweites Mal in beiden `.entitlements`-Dateien
/// (`App/App.entitlements`, `ShareExtension/ShareExtension.entitlements`) —
/// das ist die Stelle, die iOS liest. Wer sie ändert, zieht alle drei mit.
enum AppGruppe {
    static let kennung = "group.com.howispulse.app"

    /// `nil`, wenn dem laufenden Bau das Entitlement fehlt — am Gerät etwa
    /// dann, wenn das Profil die Gruppe noch nicht trägt. Jeder Aufrufer muss
    /// das als „hier gibt es nichts“ behandeln, nicht als Absturzgrund.
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: kennung)
    }
}
