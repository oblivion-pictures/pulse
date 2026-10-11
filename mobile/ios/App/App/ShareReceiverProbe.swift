import Capacitor
import ImageIO
import UIKit
import WebKit

#if DEBUG
    /// **Prüfpfad für den Teilen-Empfang — nur in Debug-Bauten** (Muster:
    /// `WiedergabebegrenzerProbe.swift`).
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app -PulseTeilenProbe ablegen
    ///     xcrun simctl launch <sim> com.howispulse.app -PulseTeilenProbe lesen
    ///
    /// **Geht den Weg der Web-Seite, nicht eine Abkürzung daneben:** gerufen
    /// wird IN der WebView, über `Capacitor.nativePromise('ShareReceiver',
    /// 'getPending')` — genau das, was `registerPlugin(…).getPending()` in
    /// `shareEmpfang.ts` darunter tut. Belegt damit dreierlei: das Plugin ist
    /// registriert (steht in `PluginHeaders`, also in `packageClassList`), es
    /// liest den gemeinsamen Container, und der zweite Aufruf ist leer.
    ///
    /// `ablegen` legt vorher ein Prüfpaket ab, mit derselben `TeilenAblage`
    /// wie die Erweiterung — und erst, wenn die Seite steht, damit die Web-App
    /// es nicht beim Start selbst abholt.
    /// `lesen` legt nichts ab: der Lauf nach einem echten Teilen aus Safari
    /// oder Fotos. Holt die Web-App das Paket beim Start schon selbst ab
    /// (sobald ihr iOS-Riegel ausgeliefert ist), kommt hier „leer“ an — dann
    /// hat der Normalweg gewonnen, nicht das Plugin versagt.
    enum ShareReceiverProbe {
        static func ausStartargumenten() {
            guard let art = UserDefaults.standard.string(forKey: "PulseTeilenProbe") else { return }
            if art == "wettlauf" {
                Task.detached { await wettlauf() }
                return
            }
            Task { @MainActor in await fahren(ablegen: art == "ablegen") }
        }

        /// `-PulseTeilenProbe wettlauf` (iOS-Bughunt 2, D3): Ergebnis, Frist und
        /// Abbruch der Teilen-Erweiterung — genau einer entscheidet, auch wenn
        /// alle drei gleichzeitig kommen. Braucht keine WebView.
        private static func wettlauf() async {
            let eins = TeilenWettlauf()
            soll("D3: die Frist schlägt eine spätere Arbeit", eins.entscheiden(.abgelaufen)
                && !eins.entscheiden(.fertig) && !eins.entscheiden(.abgebrochen))
            let zwei = TeilenWettlauf()
            soll("D3: eine fertige Arbeit schlägt Frist und Abbruch", zwei.entscheiden(.fertig)
                && !zwei.entscheiden(.abgelaufen) && !zwei.entscheiden(.abgebrochen))
            var abweichungen = 0
            for _ in 0 ..< 2000 {
                let w = TeilenWettlauf()
                let gewonnen = await withTaskGroup(of: Bool.self) { gruppe in
                    for a in [TeilenWettlauf.Ausgang.fertig, .abgelaufen, .abgebrochen] {
                        gruppe.addTask { w.entscheiden(a) }
                    }
                    return await gruppe.reduce(0) { $0 + ($1 ? 1 : 0) }
                }
                if gewonnen != 1 { abweichungen += 1 }
            }
            soll("D3: 2000 Läufe mit drei gleichzeitigen Entscheidern, je genau einer gewinnt "
                + "(\(abweichungen) Abweichungen)", abweichungen == 0)
        }

        private static func soll(_ was: String, _ ist: Bool) {
            NSLog("[PulseTeilen] Probe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        @MainActor private static func fahren(ablegen: Bool) async {
            guard let webView = await bereiteWebView() else {
                NSLog("[PulseTeilen] Probe: WebView mit Capacitor-Brücke nach 60 s nicht bereit")
                return
            }
            let registriert = try? await webView.callAsyncJavaScript(
                "return (window.Capacitor.PluginHeaders || []).some(h => h.name === 'ShareReceiver')",
                contentWorld: .page) as? Bool
            soll("ShareReceiver steht in PluginHeaders", registriert == true)

            var erwartet: String?
            if ablegen {
                // Kurz warten: die Web-App holt beim Start selbst ab, und das
                // Prüfpaket soll ihr nicht in die Hände fallen.
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                erwartet = "Pulse-Teilen-Probe \(UUID().uuidString.prefix(8))"
                do {
                    try TeilenAblage.ablegen(GeteiltesPaket(
                        text: erwartet, bild: pruefbild(), bildMime: "image/jpeg", abgelegt: Date()))
                    NSLog("[PulseTeilen] Probe: Prüfpaket abgelegt")
                } catch {
                    soll("Prüfpaket ablegen (\(error))", false)
                    return
                }
            }

            let erster = await holen(webView)
            NSLog("[PulseTeilen] Probe erster Abruf: %@", erster.beschreibung)
            if let erwartet {
                soll("Text kommt unverändert an", erster.text == erwartet)
                soll("Bild kommt als JPEG an", erster.bildBytes > 0 && erster.mime == "image/jpeg")
            }
            let zweiter = await holen(webView)
            NSLog("[PulseTeilen] Probe zweiter Abruf: %@", zweiter.beschreibung)
            soll("zweiter Abruf ist leer", !zweiter.fehlgeschlagen && zweiter.text == nil && zweiter.bildBytes == 0)
        }

        private struct Abruf {
            var text: String?
            var bildBytes = 0
            var mime: String?
            var masse = "-"
            var fehlgeschlagen = false
            var beschreibung: String {
                if fehlgeschlagen { return "Aufruf fehlgeschlagen" }
                let anriss = text.map { "\"\($0.prefix(80))\" (\($0.count) Zeichen)" } ?? "kein Text"
                return "\(anriss), Bild \(bildBytes) Bytes \(mime ?? "-") \(masse)"
            }
        }

        @MainActor private static func holen(_ webView: WKWebView) async -> Abruf {
            let js = """
            const p = await window.Capacitor.nativePromise('ShareReceiver', 'getPending', {});
            return { text: p.text ?? '', bild: p.imageBase64 ?? '', mime: p.imageMime ?? '' };
            """
            guard let roh = try? await webView.callAsyncJavaScript(js, contentWorld: .page) as? [String: Any]
            else { return Abruf(fehlgeschlagen: true) }
            var abruf = Abruf()
            if let text = roh["text"] as? String, !text.isEmpty { abruf.text = text }
            if let mime = roh["mime"] as? String, !mime.isEmpty { abruf.mime = mime }
            if let b64 = roh["bild"] as? String, let daten = Data(base64Encoded: b64) {
                abruf.bildBytes = daten.count
                if let quelle = CGImageSourceCreateWithData(daten as CFData, nil),
                   let eig = CGImageSourceCopyPropertiesAtIndex(quelle, 0, nil) as? [CFString: Any],
                   let b = eig[kCGImagePropertyPixelWidth] as? Int, let h = eig[kCGImagePropertyPixelHeight] as? Int {
                    abruf.masse = "\(b)×\(h) (\(String(format: "%.1f", Double(b * h) / 1e6)) MP)"
                }
            }
            return abruf
        }

        @MainActor private static func bereiteWebView() async -> WKWebView? {
            for _ in 0 ..< 120 {
                let wurzel = (UIApplication.shared.delegate as? AppDelegate)?.window?.rootViewController
                if let webView = (wurzel as? CAPBridgeViewController)?.webView,
                   let bereit = try? await webView.callAsyncJavaScript(
                       "return document.readyState === 'complete' && typeof window.Capacitor?.nativePromise === 'function'",
                       contentWorld: .page) as? Bool, bereit {
                    return webView
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            return nil
        }

        private static func pruefbild() -> Data? {
            UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { kontext in
                UIColor.systemBlue.setFill()
                kontext.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
            }.jpegData(compressionQuality: 0.8)
        }
    }
#endif
