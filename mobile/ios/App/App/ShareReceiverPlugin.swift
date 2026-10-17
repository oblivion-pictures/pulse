import Capacitor
import Foundation

/// Empfangsbrücke für geteilte Inhalte — das iOS-Gegenstück zu
/// `mobile/android/.../ShareReceiverPlugin.java` (Punkt 41 der iOS-Liste).
///
/// **Gleicher JS-Name, gleiche Methode:** `ShareReceiver.getPending()`. Die
/// Web-Seite (`web/src/lib/platform/shareEmpfang.ts`) kennt damit einen Weg für
/// beide Plattformen; die Antwort hat zwei Fassungen:
///  - **Mit `mitDateien: true`** (die aktuelle Web-App): `{text?, paketId?,
///    dateien?: [{id, name, mime, groesse}], uebersprungen?}`. Die Dateien
///    stehen NICHT in der Antwort — Base64 über die Brücke trägt keine 25 MiB
///    (und eine Brücke, die verstopft, hat die App schon einmal einfrieren
///    lassen). Die Seite holt sie danach Stück für Stück mit `leseDatei` und
///    meldet mit `abschliessen`, dass sie fertig ist.
///  - **Ohne** (eine ältere Web-App, Selbst-Hoster): wie früher
///    `{text?, imageBase64?, imageMime?}` — das erste Bild, alles andere fällt
///    weg, und der Container wird sofort geleert (die alte Seite meldet nie
///    zurück).
///
/// **Der Unterschied zu Android liegt davor.** Auf Android landet ein Teilen
/// als Intent in derselben App. Auf iOS nimmt es eine eigene Erweiterung
/// entgegen — ein anderes Programm —, und der einzige Weg von dort hierher ist
/// der gemeinsame Container (`TeilenAblage`). Das Paket überlebt deshalb auch
/// einen Neustart der App, bis es abgeholt wird; unabgeholte Dateien räumt
/// `TeilenAblage.aufraeumen` nach 24 Stunden weg.
///
/// `getPending` antwortet IMMER (leer, wenn nichts da ist oder der Container
/// fehlt) und lehnt nie ab: die Web-Seite fragt bei jedem Start und jeder
/// Rückkehr in den Vordergrund, und „nichts da“ ist dort der Normalfall.
@objc(ShareReceiverPlugin)
public class ShareReceiverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareReceiverPlugin"
    public let jsName = "ShareReceiver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "leseDatei", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abschliessen", returnType: CAPPluginReturnPromise)
    ]

    /// So viel Rohdaten je Stück: Base64 macht ein Drittel mehr, und die
    /// Brücke ist eine einzige Warteschlange — lieber viele kleine als ein
    /// grosser Brocken. **Gesetzt, nicht gemessen.**
    static let stueckBytes = 384 * 1024

    public override func load() {
        DispatchQueue.global(qos: .utility).async { TeilenAblage.aufraeumen() }
    }

    @objc func getPending(_ call: CAPPluginCall) {
        let mitDateien = call.getBool("mitDateien") ?? false
        // Dateien lesen und Base64 bilden gehört nicht auf den Hauptfaden.
        DispatchQueue.global(qos: .userInitiated).async {
            TeilenAblage.aufraeumen()
            call.resolve(Self.antwort(TeilenAblage.entnehmen(), mitDateien: mitDateien))
        }
    }

    /// Ein Stück einer Datei: `{base64, ende}`. `offset`/`laenge` in Bytes;
    /// `ende` ist wahr, wenn danach nichts mehr kommt. Kennungen werden gegen
    /// UUID-Form geprüft (`TeilenAblage.datei`), sie führen nie aus dem Ordner.
    @objc func leseDatei(_ call: CAPPluginCall) {
        guard let paketId = call.getString("paketId"), let id = call.getString("id"),
              let url = TeilenAblage.datei(paketId: paketId, id: id)
        else {
            call.reject("datei_unbekannt")
            return
        }
        let offset = max(0, call.getInt("offset") ?? 0)
        let laenge = min(max(1, call.getInt("laenge") ?? Self.stueckBytes), Self.stueckBytes)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let griff = try FileHandle(forReadingFrom: url)
                defer { try? griff.close() }
                try griff.seek(toOffset: UInt64(offset))
                let daten = try griff.read(upToCount: laenge) ?? Data()
                let gesamt = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                call.resolve([
                    "base64": daten.base64EncodedString(),
                    "ende": offset + daten.count >= gesamt
                ])
            } catch {
                call.reject("datei_fehlt")
            }
        }
    }

    /// Die Seite ist fertig (oder verwirft): Dateien des Pakets löschen.
    @objc func abschliessen(_ call: CAPPluginCall) {
        if let paketId = call.getString("paketId") {
            DispatchQueue.global(qos: .utility).async { TeilenAblage.paketLoeschen(paketId) }
        }
        call.resolve()
    }

    static func antwort(_ paket: GeteiltesPaket?, mitDateien: Bool) -> [String: Any] {
        var antwort: [String: Any] = [:]
        guard let paket else { return antwort }
        if let text = paket.text, !text.isEmpty { antwort["text"] = text }
        if mitDateien {
            guard !paket.dateien.isEmpty else {
                TeilenAblage.paketLoeschen(paket.paketId)
                return antwort
            }
            antwort["paketId"] = paket.paketId
            antwort["dateien"] = paket.dateien.map {
                ["id": $0.id, "name": $0.name, "mime": $0.mime, "groesse": $0.groesse] as [String: Any]
            }
            if paket.uebersprungen > 0 { antwort["uebersprungen"] = paket.uebersprungen }
            return antwort
        }
        // Ältere Web-App: das erste Bild als Base64, wie früher.
        if let bild = paket.dateien.first(where: { $0.mime.hasPrefix("image/") }),
           let url = TeilenAblage.datei(paketId: paket.paketId, id: bild.id),
           let daten = try? Data(contentsOf: url), !daten.isEmpty {
            antwort["imageBase64"] = daten.base64EncodedString()
            antwort["imageMime"] = bild.mime
        }
        TeilenAblage.paketLoeschen(paket.paketId)
        return antwort
    }
}
