import ImageIO
import UniformTypeIdentifiers

/// Begrenzt ein geteiltes Bild, bevor es abgelegt wird.
///
/// **Warum überhaupt.** Eine Teilen-Erweiterung lebt unter einer engen
/// Speichergrenze (gängig genannt: rund 120 MB, selbst nicht gemessen; wer
/// darüber kommt, wird ohne Rückfrage beendet), und ein Foto aus einer
/// aktuellen iPhone-Kamera hat 48 Megapixel — ausgepackt knapp 200 MB.
/// Ausserdem reist das Bild danach über die Brücke in die WebView (Base64 in Stücken, `ShareReceiverPlugin`).
/// Deshalb wird nie das ganze Bild ausgepackt, sondern über ImageIO gleich in
/// der Zielgrösse gelesen (`CGImageSourceCreateThumbnail…` aus der Datei,
/// nicht über `UIImage`).
///
/// **Grenze über die Bildpunkt-ZAHL, nicht über die lange Kante.** Eine
/// Kantengrenze machte aus einem langen Bildschirmfoto einer Webseite
/// (1179 × 10 000) einen unlesbaren Streifen von 240 px Breite. Mit 6 MP
/// bleibt ein 12-MP-Foto bei 2828 × 2121 und das lange Bildschirmfoto bei
/// 841 × 7133. Der Wert ist eine Produktfrage (Roadmap Punkt 41) und hier
/// die einzige Stelle, an der er steht.
///
/// **Ausgabe: JPEG, ausser die Quelle ist PNG.** HEIC kann nicht jeder
/// Empfänger anzeigen (Android, Chromium); PNG bleibt PNG, weil Bildschirmfotos
/// mit Text als JPEG ausfransen und Transparenz verloren ginge. Ein bewegtes
/// GIF verliert dabei die Bewegung — bewusst, ein geteiltes Bild wird zu einem Standbild.
///
/// **Nebenwirkung, die man kennen muss:** neu kodiert wird aus den
/// Bildpunkten, die Metadaten der Quelle (EXIF, darunter der Aufnahmeort)
/// reisen NICHT mit. Android reicht das Original samt EXIF durch.
enum TeilenBild {
    typealias Kodiert = (daten: Data, mime: String)

    static let hoechstensBildpunkte = 6_000_000
    static let jpegGuete = 0.85

    static func begrenzen(_ quelle: CGImageSource) -> Kodiert? {
        guard CGImageSourceGetCount(quelle) > 0,
              let eig = CGImageSourceCopyPropertiesAtIndex(quelle, 0, nil) as? [CFString: Any],
              let breite = eig[kCGImagePropertyPixelWidth] as? Int,
              let hoehe = eig[kCGImagePropertyPixelHeight] as? Int,
              breite > 0, hoehe > 0
        else { return nil }
        let faktor = min(1, (Double(hoechstensBildpunkte) / Double(breite * hoehe)).squareRoot())
        let kante = max(1, Int(Double(max(breite, hoehe)) * faktor))
        let leseOptionen: [CFString: Any] = [
            // Immer aus dem Bild selbst: ein eingebettetes Vorschaubild ist
            // oft nur 160 px gross und wäre sonst das, was ankommt.
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            // Dreht nach der EXIF-Lage — die Lage-Angabe reist nicht mit
            // (s. oben), das Bild muss also schon aufrecht stehen.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: kante,
        ]
        guard let bild = CGImageSourceCreateThumbnailAtIndex(quelle, 0, leseOptionen as CFDictionary)
        else { return nil }

        let istPng = (CGImageSourceGetType(quelle) as String?) == UTType.png.identifier
        let typ = istPng ? UTType.png : UTType.jpeg
        let ziel = NSMutableData()
        guard let schreiber = CGImageDestinationCreateWithData(ziel, typ.identifier as CFString, 1, nil)
        else { return nil }
        let schreibOptionen: [CFString: Any] =
            istPng ? [:] : [kCGImageDestinationLossyCompressionQuality: jpegGuete]
        CGImageDestinationAddImage(schreiber, bild, schreibOptionen as CFDictionary)
        guard CGImageDestinationFinalize(schreiber) else { return nil }
        return (ziel as Data, istPng ? "image/png" : "image/jpeg")
    }
}
