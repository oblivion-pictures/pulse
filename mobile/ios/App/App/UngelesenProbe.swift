import Capacitor
import UIKit
import WebKit

#if DEBUG
    /// **Prüfpfad für das Widget „Ungelesen“ — nur in Debug-Bauten** (Muster:
    /// `ShareReceiverProbe.swift`).
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app -PulseUngelesenProbe 7
    ///
    /// **Geht den Weg der Web-Seite:** gerufen wird IN der WebView, über
    /// `Capacitor.nativePromise('Ungelesen', 'setzen', …)` — das, was
    /// `registerPlugin(…).setzen()` in `platform/ungelesenWidget.ts` darunter
    /// tut. Belegt damit: das Plugin ist registriert (`PluginHeaders`, also
    /// `packageClassList`), und die Zahl landet im gemeinsamen Container, aus
    /// dem das Widget liest. Ob das Widget sie ZEIGT, zeigt der Bildschirm.
    enum UngelesenProbe {
        static func ausStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseUngelesenProbe"),
                  let anzahl = Int(roh) else { return }
            Task { @MainActor in await fahren(anzahl) }
        }

        private static func soll(_ was: String, _ ist: Bool) {
            NSLog("[PulseUngelesen] Probe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        @MainActor private static func fahren(_ anzahl: Int) async {
            guard let webView = await bereiteWebView() else {
                NSLog("[PulseUngelesen] Probe: WebView mit Capacitor-Brücke nach 60 s nicht bereit")
                return
            }
            let registriert = try? await webView.callAsyncJavaScript(
                "return (window.Capacitor.PluginHeaders || []).some(h => h.name === 'Ungelesen')",
                contentWorld: .page) as? Bool
            soll("Ungelesen steht in PluginHeaders", registriert == true)
            // Die Web-App legt beim Start womöglich selbst ihre Zahl ab — der
            // Prüfwert kommt danach, damit er gewinnt.
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            let gerufen = try? await webView.callAsyncJavaScript(
                "await window.Capacitor.nativePromise('Ungelesen', 'setzen', { anzahl }); return true",
                arguments: ["anzahl": anzahl], contentWorld: .page) as? Bool
            soll("setzen über die Brücke beantwortet", gerufen == true)
            let stand = UngelesenAblage.lesen()
            NSLog("[PulseUngelesen] Probe Container: %ld, Stand %@", stand.anzahl,
                  stand.zeit.map { "\($0)" } ?? "-")
            soll("Container trägt \(anzahl)", stand.anzahl == max(0, anzahl))
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
    }
#endif
