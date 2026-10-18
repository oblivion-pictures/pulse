import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Legt EINE geteilte Datei (Bild, Video, Dokument) in den Paket-Ordner des
/// gemeinsamen Containers (`TeilenAblage`).
///
/// **Kopiert wird auf der Platte, nichts kommt in den Speicher** — die
/// Erweiterung lebt unter einer engen Speichergrenze (`TeilenBild`), eine
/// 25-MiB-Datei als `Data` wäre ein Risiko. Nur Bilder werden neu kodiert
/// (verkleinert, wie bisher), alles andere unverändert übernommen.
///
/// `loadFileRepresentation` liefert eine Datei, die NUR innerhalb des
/// Rückrufs gilt; deshalb wird dort kopiert, nicht beim Aufrufer.
enum TeilenDateien {
    enum Ergebnis {
        case abgelegt(GeteilteDatei)
        /// Über der Dateigrenze oder der Restmenge — wird übersprungen.
        case zuGross
        case fehlgeschlagen
    }

    /// Kopiert die Datei eines Anbieters unverändert.
    /// `typ`: ein vom Anbieter angebotener Typ, der eine Datei liefert.
    static func kopieren(_ anbieter: NSItemProvider, typ: String, in ordner: URL, restBytes: Int) async -> Ergebnis {
        await withCheckedContinuation { fortsetzung in
            _ = anbieter.loadFileRepresentation(forTypeIdentifier: typ) { quelle, _ in
                guard let quelle else {
                    fortsetzung.resume(returning: .fehlgeschlagen)
                    return
                }
                let grenze = min(TeilenGrenzen.dateiBytes, restBytes)
                // Früh abweisen, was schon an der Quelle zu groß ist (spart die
                // Kopie) — eine unbekannte Größe gilt hier NICHT als 0, sie wird
                // nach der Kopie am Ziel gelesen.
                if let vorab = (try? quelle.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, vorab > grenze {
                    fortsetzung.resume(returning: .zuGross)
                    return
                }
                let id = UUID().uuidString
                let ziel = ordner.appendingPathComponent(id)
                do {
                    try FileManager.default.copyItem(at: quelle, to: ziel)
                } catch {
                    NSLog("[PulseTeilen] Kopieren fehlgeschlagen: %@", "\(error)")
                    fortsetzung.resume(returning: .fehlgeschlagen)
                    return
                }
                // Maßgeblich ist die Größe der KOPIE: sie ist, was die Hülle
                // später ausliefert. Unlesbar oder 0 → ablehnen und wegräumen
                // (eine leere Datei lehnt der Server ohnehin ab).
                guard let groesse = (try? ziel.resourceValues(forKeys: [.fileSizeKey]))?.fileSize,
                      groesse > 0 else {
                    try? FileManager.default.removeItem(at: ziel)
                    fortsetzung.resume(returning: .fehlgeschlagen)
                    return
                }
                guard groesse <= grenze else {
                    try? FileManager.default.removeItem(at: ziel)
                    fortsetzung.resume(returning: .zuGross)
                    return
                }
                let endung = quelle.pathExtension
                fortsetzung.resume(returning: .abgelegt(GeteilteDatei(
                    id: id, name: bereinigt(quelle.lastPathComponent, ersatz: "Datei"),
                    mime: mime(endung: endung, typ: typ), groesse: groesse)))
            }
        }
    }

    /// Schreibt ein schon verkleinertes Bild (`TeilenBild`) als Datei.
    static func ablegen(bild: TeilenBild.Kodiert, vorgeschlagenerName: String?, in ordner: URL) -> Ergebnis {
        guard bild.daten.count <= TeilenGrenzen.dateiBytes else { return .zuGross }
        let id = UUID().uuidString
        do {
            try bild.daten.write(to: ordner.appendingPathComponent(id))
        } catch {
            NSLog("[PulseTeilen] Bild schreiben fehlgeschlagen: %@", "\(error)")
            return .fehlgeschlagen
        }
        let endung = bild.mime == "image/png" ? "png" : "jpg"
        let stamm = vorgeschlagenerName.map { ($0 as NSString).deletingPathExtension } ?? ""
        return .abgelegt(GeteilteDatei(
            id: id, name: bereinigt(stamm, ersatz: "Bild") + "." + endung,
            mime: bild.mime, groesse: bild.daten.count))
    }

    /// Ein Name, der nichts ausser einem Namen sein kann: kein Pfad, keine
    /// Steuerzeichen, höchstens 120 Zeichen.
    static func bereinigt(_ name: String, ersatz: String) -> String {
        let verboten = CharacterSet(charactersIn: "/\\:").union(.controlCharacters)
        let sauber = name.components(separatedBy: verboten).joined(separator: "_")
            .trimmingCharacters(in: .whitespaces)
        return sauber.isEmpty ? ersatz : String(sauber.prefix(120))
    }

    private static func mime(endung: String, typ: String) -> String {
        UTType(filenameExtension: endung)?.preferredMIMEType
            ?? UTType(typ)?.preferredMIMEType
            ?? "application/octet-stream"
    }
}
