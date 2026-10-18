import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Liest aus dem, was die Quell-App anbietet, EIN Paket und legt es ab.
///
/// Angenommen wird, was die Web-Seite verbrauchen kann (`MessageInput.svelte`,
/// `freigabeUebernehmen`): Text für den Verfasser und bis zu
/// `TeilenGrenzen.hoechstensElemente` Dateien für den Anhang-Streifen — Bilder
/// (verkleinert, `TeilenBild`), Videos und Dokumente (unverändert kopiert,
/// `TeilenDateien`). Eine Web-Adresse wird zu Text — Android bekommt sie
/// genauso, als `EXTRA_TEXT`. Was über Datei- oder Gesamtgrenze liegt oder
/// über der Anzahl, wird übersprungen und gezählt; die Karte sagt es.
enum TeilenEinsammeln {
    enum Ausgang {
        case abgelegt, nichtsBrauchbares, fehlgeschlagen
        /// Frist oder Abbruch haben vorher entschieden (`TeilenWettlauf`) —
        /// es wurde nichts abgelegt, und die Karte hat darauf schon reagiert.
        case ueberholt
    }

    struct Ergebnis {
        var ausgang: Ausgang
        /// Wie viele Elemente übernommen sind (Text zählt als eines).
        var elemente = 0
        var uebersprungen = 0
    }

    /// Abgelegt wird nur, wenn `wettlauf` es noch zulässt: ist die Frist um
    /// oder hat der Nutzer abgebrochen, bleibt die Ablage leer.
    static func einsammelnUndAblegen(_ eingaben: [Any], wettlauf: TeilenWettlauf) async -> Ergebnis {
        var texte: [String] = []
        var dateien: [GeteilteDatei] = []
        var uebersprungen = 0
        var belegt = 0
        var paketOrdner: (id: String, ordner: URL)?

        /// Räumt den angelegten Paket-Ordner weg, wenn nichts abgelegt wird.
        func ordnerVerwerfen() {
            if let ordner = paketOrdner { TeilenAblage.paketLoeschen(ordner.id) }
        }

        /// Legt die Datei an (Ordner beim ersten Mal) und bucht das Ergebnis.
        func ablegen(_ lade: (URL, Int) async -> TeilenDateien.Ergebnis) async {
            if dateien.count >= TeilenGrenzen.hoechstensElemente {
                uebersprungen += 1
                return
            }
            if paketOrdner == nil { paketOrdner = try? TeilenAblage.neuerPaketOrdner() }
            guard let ziel = paketOrdner else {
                uebersprungen += 1
                return
            }
            switch await lade(ziel.ordner, TeilenGrenzen.gesamtBytes - belegt) {
            case .abgelegt(let datei):
                dateien.append(datei)
                belegt += datei.groesse
            case .zuGross, .fehlgeschlagen:
                uebersprungen += 1
            }
        }

        for case let eintrag as NSExtensionItem in eingaben {
            for anbieter in eintrag.attachments ?? [] {
                let kopieren: (URL, Int) async -> TeilenDateien.Ergebnis = { ordner, rest in
                    await dateiKopieren(anbieter, in: ordner, restBytes: rest)
                }
                #if DEBUG
                    NSLog("[PulseTeilen] Angebot: %@", anbieter.registeredTypeIdentifiers.joined(separator: ", "))
                #endif
                // Reihenfolge ist Absicht: ein Bild aus „Dateien“ ist zugleich
                // eine Datei-Adresse; eine Web-Adresse aus Safari kann neben
                // dem Link auch ein Webarchiv anbieten, gemeint ist der Link.
                if anbieter.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    await ablegen { ordner, rest in
                        await bildAlsDatei(anbieter, in: ordner, restBytes: rest)
                    }
                } else if anbieter.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                    await ablegen(kopieren)
                } else if anbieter.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let adresse = await webAdresse(anbieter) {
                        texte.append(adresse)
                    } else {
                        // Eine Datei-Adresse: gemeint ist die Datei dahinter.
                        await ablegen(kopieren)
                    }
                } else if anbieter.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = await klartext(anbieter) { texte.append(text) }
                } else if anbieter.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
                    await ablegen(kopieren)
                }
            }
        }
        // Dieselbe Zeichenkette kann doppelt kommen (Adresse als URL und als
        // Text) — einmal genügt, Reihenfolge wie angeboten.
        var gesehen = Set<String>()
        let text = texte.filter { gesehen.insert($0).inserted }.joined(separator: "\n")
        // Auch „nichts brauchbar" ist ein Ergebnis, das erst gelten darf, wenn
        // Frist und Abbruch nicht schon entschieden haben — sonst überschriebe
        // es die Karte der Frist, oder zeigte etwas nach einem Abbruch.
        guard wettlauf.entscheiden(.fertig) else {
            ordnerVerwerfen()
            return Ergebnis(ausgang: .ueberholt)
        }
        guard !text.isEmpty || !dateien.isEmpty else {
            ordnerVerwerfen()
            return Ergebnis(ausgang: .nichtsBrauchbares, uebersprungen: uebersprungen)
        }

        // Nur Text: kein Ordner nötig, die Kennung ist trotzdem gültig.
        let paketId = paketOrdner?.id ?? UUID().uuidString
        let paket = GeteiltesPaket(
            paketId: paketId, text: text.isEmpty ? nil : text, dateien: dateien,
            uebersprungen: uebersprungen, abgelegt: Date())
        do {
            try TeilenAblage.ablegen(paket)
            NSLog("[PulseTeilen] abgelegt: Text %ld Zeichen, %ld Dateien (%ld Bytes), %ld übersprungen",
                  text.count, dateien.count, belegt, uebersprungen)
            return Ergebnis(
                ausgang: .abgelegt, elemente: dateien.count + (text.isEmpty ? 0 : 1),
                uebersprungen: uebersprungen)
        } catch {
            NSLog("[PulseTeilen] Ablegen fehlgeschlagen: %@", "\(error)")
            ordnerVerwerfen()
            return Ergebnis(ausgang: .fehlgeschlagen)
        }
    }

    /// Das Bild verkleinert und als Datei. Gelingt das Dekodieren nicht (ein
    /// Format, das ImageIO nicht kennt), wird die Datei unverändert kopiert.
    private static func bildAlsDatei(_ anbieter: NSItemProvider, in ordner: URL, restBytes: Int) async -> TeilenDateien.Ergebnis {
        if let bild = await bildLaden(anbieter) {
            return TeilenDateien.ablegen(bild: bild, vorgeschlagenerName: anbieter.suggestedName, in: ordner)
        }
        return await dateiKopieren(anbieter, in: ordner, restBytes: restBytes)
    }

    /// Unverändert kopieren, über den ersten angebotenen Typ, der eine Datei
    /// ist (nicht Adresse, nicht Text).
    private static func dateiKopieren(_ anbieter: NSItemProvider, in ordner: URL, restBytes: Int) async -> TeilenDateien.Ergebnis {
        let typ = anbieter.registeredTypeIdentifiers.first { kennung in
            guard let t = UTType(kennung) else { return false }
            return t.conforms(to: .data) && !t.conforms(to: .url) && !t.conforms(to: .plainText)
        } ?? anbieter.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true }
        guard let typ else { return .fehlgeschlagen }
        return await TeilenDateien.kopieren(anbieter, typ: typ, in: ordner, restBytes: restBytes)
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
