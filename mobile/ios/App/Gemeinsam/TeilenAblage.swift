import Foundation

/// Ein geteilter Inhalt auf dem Weg von der Teilen-Erweiterung in die App
/// (Punkt 41 der iOS-Liste). Die Form folgt dem, was die Web-Seite kennt
/// (`web/src/lib/freigabe/freigabeStore.ts`): Text und höchstens EIN Bild.
struct GeteiltesPaket: Codable {
    var text: String?
    var bild: Data?
    var bildMime: String?
    /// Nicht ausgewertet. Steht da, damit eine spätere Verfallsregel nicht
    /// erst einen neuen Paketaufbau braucht — ob es eine geben soll, ist eine
    /// offene Produktfrage (Roadmap Punkt 41).
    var abgelegt: Date
}

/// Ablage für genau EIN Paket im gemeinsamen Container.
///
/// **Ein zweites Teilen ersetzt das erste** — dieselbe Regel wie auf Android
/// und in der Web-Ablage: wer erneut teilt, meinte das alte nicht mehr. Ein
/// Paket ist deshalb eine einzige Datei, und beide Seiten fassen sie nur über
/// Umbenennungen an. Damit sieht jede Seite das Paket entweder ganz oder gar
/// nicht, ohne dass es eine Sperre zwischen den Prozessen braucht:
///  - **Ablegen** schreibt atomar (`.atomic`: erst eine Nebendatei, dann
///    umbenennen). Eine halb geschriebene Datei ist nie unter dem Namen zu sehen.
///  - **Entnehmen** benennt die Datei ZUERST um und liest dann. Wer erst läse
///    und danach löschte, könnte ein Paket löschen, das die Erweiterung in
///    genau diesem Augenblick neu abgelegt hat — es wäre wortlos weg.
enum TeilenAblage {
    static let dateiname = "geteilt.plist"

    enum Fehler: Error { case keinContainer }

    static func ablegen(_ paket: GeteiltesPaket) throws {
        guard let ordner = AppGruppe.container else { throw Fehler.keinContainer }
        let daten = try PropertyListEncoder().encode(paket)
        try daten.write(to: ordner.appendingPathComponent(dateiname), options: .atomic)
    }

    /// Holt das Paket und leert die Ablage damit. `nil` heisst „nichts da“ —
    /// auch dann, wenn der Container fehlt oder die Datei kaputt ist; beides
    /// wird geloggt, aber nicht nach oben gereicht, weil der Aufrufer (das
    /// Plugin) in keinem der Fälle etwas anderes tun könnte als „leer“ melden.
    static func entnehmen() -> GeteiltesPaket? {
        guard let ordner = AppGruppe.container else {
            NSLog("[PulseTeilen] kein gemeinsamer Container — Entitlement fehlt?")
            return nil
        }
        let fm = FileManager.default
        let entnommen = ordner.appendingPathComponent("entnommen-\(UUID().uuidString).plist")
        do {
            try fm.moveItem(at: ordner.appendingPathComponent(dateiname), to: entnommen)
        } catch let fehler as CocoaError where fehler.code == .fileNoSuchFile {
            return nil
        } catch {
            NSLog("[PulseTeilen] Entnehmen fehlgeschlagen: %@", "\(error)")
            return nil
        }
        defer { try? fm.removeItem(at: entnommen) }
        do {
            return try PropertyListDecoder().decode(GeteiltesPaket.self, from: Data(contentsOf: entnommen))
        } catch {
            NSLog("[PulseTeilen] Paket unlesbar, verworfen: %@", "\(error)")
            return nil
        }
    }
}
