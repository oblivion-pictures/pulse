import Capacitor
import Foundation

/// Empfangsbrücke für geteilte Inhalte — das iOS-Gegenstück zu
/// `mobile/android/.../ShareReceiverPlugin.java` (Punkt 41 der iOS-Liste).
///
/// **Gleicher JS-Name, gleiche Methode, gleiche Antwort:**
/// `ShareReceiver.getPending()` → `{text?, imageBase64?, imageMime?}`. Die
/// Web-Seite (`web/src/lib/platform/shareEmpfang.ts`) kennt damit nur EINEN
/// Weg für beide Plattformen.
///
/// **Der Unterschied liegt davor.** Auf Android landet ein Teilen als Intent
/// in derselben App, das Paket liegt im Speicher dieses Plugins. Auf iOS nimmt
/// es eine eigene Erweiterung entgegen — ein anderes Programm —, und der einzige
/// Weg von dort hierher ist der gemeinsame Container (`TeilenAblage`). Das
/// Paket überlebt deshalb auch einen Neustart der App, bis es abgeholt wird.
///
/// Abholen leert den Container, wie `getPending` auf Android das Plugin leert.
/// Die Methode antwortet IMMER (leer, wenn nichts da ist oder der Container
/// fehlt) und lehnt nie ab: die Web-Seite fragt bei jedem Start und jeder
/// Rückkehr in den Vordergrund, und „nichts da“ ist dort der Normalfall.
@objc(ShareReceiverPlugin)
public class ShareReceiverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareReceiverPlugin"
    public let jsName = "ShareReceiver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPending", returnType: CAPPluginReturnPromise)
    ]

    @objc func getPending(_ call: CAPPluginCall) {
        // Datei lesen und Base64 bilden (einige MB) gehört nicht auf den
        // Hauptfaden.
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(Self.antwort(TeilenAblage.entnehmen()))
        }
    }

    /// Base64 über die Brücke wie auf Android — das Bild ist in der
    /// Erweiterung schon begrenzt (`TeilenBild`), die Menge also überschaubar.
    static func antwort(_ paket: GeteiltesPaket?) -> [String: Any] {
        var antwort: [String: Any] = [:]
        if let text = paket?.text, !text.isEmpty { antwort["text"] = text }
        if let bild = paket?.bild, !bild.isEmpty {
            antwort["imageBase64"] = bild.base64EncodedString()
            antwort["imageMime"] = paket?.bildMime ?? "image/jpeg"
        }
        return antwort
    }
}
