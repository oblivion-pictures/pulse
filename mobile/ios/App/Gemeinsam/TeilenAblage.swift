import Foundation

/// Was die Teilen-Erweiterung annimmt — die einzige Stelle für die Zahlen.
///
/// **Die Dateigrenze ist die Vorgabe des Servers, nicht die des Zielchats.**
/// Die Erweiterung weiss nicht, in welchen Chat der Nutzer die Sachen gleich
/// legt. 25 MiB ist der Standard je Anhang
/// (`DEFAULT_ATTACHMENT_MAX_SIZE_BYTES` in `guild_limits.py`); eine Community
/// kann weniger erlauben, ein verschlüsselter Chat nur 5 MiB
/// (`ablage_anhang_max_bytes`) — dort lehnt der Verfasser in der App die Datei
/// ab, bevor sie hochgeladen wird. Gleiches gilt für die Anzahl je Nachricht
/// (Standard 4): zehn Elemente passen in die Teilen-Ablage, ob der Chat sie
/// alle nimmt, sagt die App.
enum TeilenGrenzen {
    static let hoechstensElemente = 10
    static let dateiBytes = 25 * 1024 * 1024
    /// Alles zusammen im Container — die Erweiterung kopiert nur, die App
    /// liest später Stück für Stück; die Grenze schützt den Speicherplatz.
    static let gesamtBytes = 100 * 1024 * 1024
    /// So lange bleiben abgelegte Dateien liegen, wenn niemand sie abholt.
    static let aufbewahrung: TimeInterval = 24 * 60 * 60
}

/// Eine abgelegte Datei. Auf der Platte heisst sie `id` (ohne Endung), der
/// echte Name steht nur hier — so kann ein Name nie aus dem Ordner führen.
struct GeteilteDatei: Codable, Equatable {
    var id: String
    var name: String
    var mime: String
    var groesse: Int
}

/// Ein geteilter Inhalt auf dem Weg von der Teilen-Erweiterung in die App
/// (Punkt 41 der iOS-Liste): Text und bis zu `TeilenGrenzen.hoechstensElemente`
/// Dateien (Bilder, Videos, Dokumente). Die Dateien selbst liegen NICHT im
/// Paket, sondern im Ordner `geteilt-dateien/<paketId>/` neben ihm — Base64
/// über die Brücke trägt keine 25 MiB.
struct GeteiltesPaket: Codable {
    var paketId: String
    var text: String?
    var dateien: [GeteilteDatei]
    /// Wie viele Elemente die Erweiterung nicht übernommen hat (zu gross,
    /// nicht lesbar, über der Anzahl). Nur zur Anzeige.
    var uebersprungen: Int
    /// Wann abgelegt — für die Aufbewahrung (`TeilenAblage.aufraeumen`).
    var abgelegt: Date
}

/// Ablage für genau EIN Paket im gemeinsamen Container: eine Beschreibung
/// (`geteilt.plist`) und der Ordner mit den Dateien.
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
    static let dateienOrdner = "geteilt-dateien"

    enum Fehler: Error { case keinContainer }

    /// Die Dateien eines Pakets. Nur gültige UUID-Kennungen, damit eine Kennung
    /// von aussen (die Brücke) nie aus dem Ordner herausführt.
    static func paketOrdner(_ paketId: String) -> URL? {
        guard UUID(uuidString: paketId) != nil, let basis = AppGruppe.container else { return nil }
        return basis.appendingPathComponent(dateienOrdner).appendingPathComponent(paketId, isDirectory: true)
    }

    static func datei(paketId: String, id: String) -> URL? {
        guard UUID(uuidString: id) != nil else { return nil }
        return paketOrdner(paketId)?.appendingPathComponent(id)
    }

    /// Legt den Ordner für ein neues Paket an.
    static func neuerPaketOrdner() throws -> (id: String, ordner: URL) {
        let id = UUID().uuidString
        guard let ordner = paketOrdner(id) else { throw Fehler.keinContainer }
        try FileManager.default.createDirectory(at: ordner, withIntermediateDirectories: true)
        return (id, ordner)
    }

    static func paketLoeschen(_ paketId: String) {
        if let ordner = paketOrdner(paketId) { try? FileManager.default.removeItem(at: ordner) }
    }

    /// **Ein zweites Teilen ersetzt das erste — samt dessen Dateien:** nach dem
    /// Ablegen fliegen alle anderen Paket-Ordner raus.
    static func ablegen(_ paket: GeteiltesPaket) throws {
        guard let ordner = AppGruppe.container else { throw Fehler.keinContainer }
        let daten = try PropertyListEncoder().encode(paket)
        try daten.write(to: ordner.appendingPathComponent(dateiname), options: .atomic)
        aufraeumen(behalte: paket.paketId, alleAnderen: true)
    }

    /// Räumt Dateien weg, die niemand abgeholt hat: Ordner, die länger als
    /// `TeilenGrenzen.aufbewahrung` unberührt liegen. Mit `alleAnderen` auch
    /// jüngere — so ersetzt ein neues Paket das alte. `behalte` schont einen
    /// Ordner (das frisch abgelegte Paket). Gerufen beim Start des Plugins und
    /// bei jedem Abruf.
    static func aufraeumen(behalte: String? = nil, alleAnderen: Bool = false) {
        guard let basis = AppGruppe.container else { return }
        let fm = FileManager.default
        let grenze = Date().addingTimeInterval(-TeilenGrenzen.aufbewahrung)
        let eintraege = (try? fm.contentsOfDirectory(
            at: basis.appendingPathComponent(dateienOrdner),
            includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for eintrag in eintraege where eintrag.lastPathComponent != behalte {
            let stand = (try? eintrag.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            if alleAnderen || stand < grenze { try? fm.removeItem(at: eintrag) }
        }
    }

    /// Holt die Beschreibung des Pakets und leert die Ablage damit — die
    /// DATEIEN bleiben liegen, bis die App sie übernommen hat (`paketLoeschen`)
    /// oder die Aufbewahrung abläuft (`aufraeumen`). `nil` heisst „nichts da“ —
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
            let paket = try PropertyListDecoder().decode(GeteiltesPaket.self, from: Data(contentsOf: entnommen))
            // Ein Paket, das länger als die Aufbewahrung unabgeholt lag, ist
            // nicht mehr gemeint — samt seinen Dateien weg.
            if Date().timeIntervalSince(paket.abgelegt) > TeilenGrenzen.aufbewahrung {
                paketLoeschen(paket.paketId)
                return nil
            }
            return paket
        } catch {
            NSLog("[PulseTeilen] Paket unlesbar, verworfen: %@", "\(error)")
            return nil
        }
    }
}
