import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Liest aus dem, was die Quell-App anbietet, EIN Paket und legt es ab.
///
/// Angenommen wird, was die Web-Seite verbrauchen kann (`MessageInput.svelte`,
/// `freigabeUebernehmen`): Text für den Verfasser und höchstens ein Bild für
/// den Anhang-Streifen. Eine Web-Adresse wird zu Text — Android bekommt sie
/// genauso, als `EXTRA_TEXT`. Mehr lässt die Aktivierungsregel in der
/// `Info.plist` gar nicht erst herein (ein Bild, eine Adresse, Text).
enum TeilenEinsammeln {
    enum Ausgang { case abgelegt, nichtsBrauchbares, fehlgeschlagen }

    static func einsammelnUndAblegen(_ eingaben: [Any]) async -> Ausgang {
        var texte: [String] = []
        var bild: TeilenBild.Kodiert?
        for case let eintrag as NSExtensionItem in eingaben {
            for anbieter in eintrag.attachments ?? [] {
                #if DEBUG
                    NSLog("[PulseTeilen] Angebot: %@", anbieter.registeredTypeIdentifiers.joined(separator: ", "))
                #endif
                // Bild zuerst: eine Bilddatei aus „Dateien“ ist zugleich eine
                // (Datei-)Adresse und landete sonst als Pfad im Text.
                if anbieter.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    if bild == nil { bild = await bildLaden(anbieter) }
                } else if anbieter.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let adresse = await webAdresse(anbieter) { texte.append(adresse) }
                } else if anbieter.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = await klartext(anbieter) { texte.append(text) }
                }
            }
        }
        // Dieselbe Zeichenkette kann doppelt kommen (Adresse als URL und als
        // Text) — einmal genügt, Reihenfolge wie angeboten.
        var gesehen = Set<String>()
        let text = texte.filter { gesehen.insert($0).inserted }.joined(separator: "\n")
        guard !text.isEmpty || bild != nil else { return .nichtsBrauchbares }

        let paket = GeteiltesPaket(
            text: text.isEmpty ? nil : text, bild: bild?.daten, bildMime: bild?.mime, abgelegt: Date())
        do {
            try TeilenAblage.ablegen(paket)
            NSLog("[PulseTeilen] abgelegt: Text %ld Zeichen, Bild %ld Bytes (%@)",
                  text.count, bild?.daten.count ?? 0, bild?.mime ?? "-")
            return .abgelegt
        } catch {
            NSLog("[PulseTeilen] Ablegen fehlgeschlagen: %@", "\(error)")
            return .fehlgeschlagen
        }
    }

    private static func bildLaden(_ anbieter: NSItemProvider) async -> TeilenBild.Kodiert? {
        // Bevorzugt als Datei: ImageIO liest dann nur, was es für die
        // Zielgrösse braucht, statt das ganze Bild in den Speicher zu holen.
        if let ausDatei = await bildAusDatei(anbieter) { return ausDatei }
        // Rückfall: manche Quellen bieten nur ein Objekt im Speicher an, etwa
        // ein bearbeitetes Bildschirmfoto als `UIImage`.
        guard let objekt = try? await anbieter.loadItem(forTypeIdentifier: UTType.image.identifier)
        else { return nil }
        let quelle: CGImageSource?
        switch objekt {
        case let adresse as URL: quelle = CGImageSourceCreateWithURL(adresse as CFURL, nil)
        case let daten as Data: quelle = CGImageSourceCreateWithData(daten as CFData, nil)
        case let uiBild as UIImage:
            quelle = uiBild.pngData().flatMap { CGImageSourceCreateWithData($0 as CFData, nil) }
        default: quelle = nil
        }
        return quelle.flatMap(TeilenBild.begrenzen)
    }

    private static func bildAusDatei(_ anbieter: NSItemProvider) async -> TeilenBild.Kodiert? {
        await withCheckedContinuation { fortsetzung in
            _ = anbieter.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { adresse, _ in
                // Die Datei gilt NUR innerhalb dieses Blocks, danach räumt iOS
                // sie weg — deshalb wird hier gelesen und nicht beim Aufrufer.
                let quelle = adresse.flatMap { CGImageSourceCreateWithURL($0 as CFURL, nil) }
                fortsetzung.resume(returning: quelle.flatMap(TeilenBild.begrenzen))
            }
        }
    }

    /// Nur Web-Adressen. Eine Datei-Adresse ist hier kein Text, den jemand
    /// lesen wollte, sondern ein Pfad in die Ablage der Quell-App.
    private static func webAdresse(_ anbieter: NSItemProvider) async -> String? {
        guard let objekt = try? await anbieter.loadItem(forTypeIdentifier: UTType.url.identifier)
        else { return nil }
        let adresse = (objekt as? URL) ?? (objekt as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
        guard let adresse, !adresse.isFileURL else { return nil }
        return adresse.absoluteString
    }

    private static func klartext(_ anbieter: NSItemProvider) async -> String? {
        guard let objekt = try? await anbieter.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        else { return nil }
        let text = (objekt as? String) ?? (objekt as? Data).flatMap { String(data: $0, encoding: .utf8) }
        let getrimmt = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return getrimmt.isEmpty ? nil : getrimmt
    }
}
