import AVFoundation
import Capacitor
import LiveKit
import UIKit

#if DEBUG
    /// **Prüfpfad für den nativen Stream-Ton — nur in Debug-Bauten**, nach dem
    /// Muster von `SprachePluginProbe`: ohne Konto und ohne Oberfläche gegen
    /// eine WHEP-Adresse (lokale MediaMTX, Testsender mit Stereo-Ton):
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app \
    ///         -PulseStreamTonProbe "<whepUrl>|<sekunden>[|bruecke]"
    ///
    /// Mit `bruecke` geht derselbe Lauf durch die ECHTE Brücke: aus der
    /// geladenen Seite heraus über `Capacitor.nativePromise`, also über den
    /// Kopf des Plugins und `packageClassList` — der Weg, den die Web-App nimmt.
    ///
    /// Belegt der Reihe nach, je Zeile `[PulseStreamTon] Probe …` im Log:
    /// Handshake, Stereo (`codecKanaele`, `fmtp`, Pegel L/R getrennt), dass
    /// LiveKit die Session ohne Sprachraum auf `.playback` stellt, Lautstärke,
    /// Verzögerung, die Übergabe `automatikAus`/`automatikAn` ohne Abbruch,
    /// und dass die Session nach dem Ende wieder frei ist.
    enum StreamTonProbe {
        static func ausStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseStreamTonProbe") else { return }
            let teile = roh.split(separator: "|").map(String.init)
            guard let url = teile.first.flatMap(URL.init(string:)) else {
                NSLog("[PulseStreamTon] Probe: erwartet \"<whepUrl>|<sekunden>\"")
                return
            }
            let dauer = teile.count > 1 ? Int(teile[1]) ?? 12 : 12
            if teile.count > 4, teile[2].hasPrefix("sprache") {
                // `sprache-ohne`: derselbe Ablauf ohne Stream-Ton — die Gegenprobe.
                let ohne = teile[2] == "sprache-ohne"
                Task { await mitSprache(url: url, wsUrl: teile[3], token: teile[4], ohneTon: ohne) }
                return
            }
            if teile.count > 2, teile[2] == "bruecke" {
                Task { await brueckeFahren(url: url, dauer: dauer) }
                return
            }
            Task { await fahren(url: url, dauer: dauer) }
        }

        private static func fahren(url: URL, dauer: Int) async {
            let v = StreamTonVerwaltung.geteilt
            let k = "probe"
            NSLog("[PulseStreamTon] Probe Session vorher: %@", sessionText())
            do {
                try await v.starten(kennung: k, url: url, lautstaerke: 1, echoFaktor: nil)
                NSLog("[PulseStreamTon] Probe VERBUNDEN %@", "\(v.zustand(k))")
            } catch {
                NSLog("[PulseStreamTon] Probe START FEHLER %@", error.localizedDescription)
                return
            }
            for s in 1 ... dauer {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                switch s {
                case 4: v.empfaenger(k)?.lautstaerkeSetzen(0); NSLog("[PulseStreamTon] Probe Lautstärke 0")
                case 6: v.empfaenger(k)?.lautstaerkeSetzen(1); NSLog("[PulseStreamTon] Probe Lautstärke 1")
                case 7: v.empfaenger(k)?.verzoegerungSetzen(ms: 200); NSLog("[PulseStreamTon] Probe Verzögerung 200")
                case 9:
                    StreamTonSitzung.geteilt.automatikAus()
                    StreamTonSitzung.geteilt.automatikAn(grund: "probe")
                    NSLog("[PulseStreamTon] Probe Übergabe gefahren")
                default: break
                }
                guard let e = v.empfaenger(k) else { break }
                let st = await e.statistik()
                let felder = st.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ")
                NSLog("[PulseStreamTon] Probe t=%d %@ | %@", s, felder, sessionText())
            }
            await v.stoppen(kennung: k)
            try? await Task.sleep(nanoseconds: 500_000_000)
            NSLog("[PulseStreamTon] Probe ENDE, Session: %@", sessionText())
        }

        /// Stream-Ton und Sprachkanal zusammen — die Übergänge, an denen die
        /// Session-Regeln hängen (`StreamTonSitzung`): Beitritt mit Mikrofon,
        /// Heilweg des Wächters (`maschineNeu`), Verlassen, Neubeitritt.
        /// `<wsUrl>|<token>` eines LiveKit-Testraums.
        private static func mitSprache(url: URL, wsUrl: String, token: String, ohneTon: Bool) async {
            let v = StreamTonVerwaltung.geteilt
            let r = SpracheRaum.geteilt
            if ProcessInfo.processInfo.environment["PULSE_LK_DEBUG"] != nil
                || UserDefaults.standard.bool(forKey: "PulseLiveKitDebug") { LiveKitSDK.setLogLevel(.debug) }
            func zeile(_ was: String) async {
                let st = await v.empfaenger("probe")?.statistik() ?? [:]
                let z = r.zustand()
                NSLog("[PulseStreamTon] Probe %@: ton=%@ L=%@ frames=%@ | sprache verbunden=%@ mikro=%@ engine=%@ | %@",
                      was, "\(st["phase"] ?? "-")", "\(st["pegelL"] ?? "-")", "\(st["frames"] ?? "-")",
                      "\(r.raum?.connectionState == .connected)", "\(z["mikro"] ?? "-")",
                      "\(r.diagnoseFelder()["engineLaeuft"] ?? "-")", sessionText())
            }
            func warten(_ s: UInt64) async { try? await Task.sleep(nanoseconds: s * 1_000_000_000) }
            do {
                if !ohneTon { try await v.starten(kennung: "probe", url: url, lautstaerke: 1, echoFaktor: nil) }
            } catch {
                NSLog("[PulseStreamTon] Probe START FEHLER %@", error.localizedDescription)
                return
            }
            await warten(3); await zeile("1 nur Ton")
            for runde in 1 ... 2 {
                do {
                    try await r.beitreten(wsUrl: wsUrl, token: token, kanalId: "probe",
                                          kanalName: "Probe", stumm: false, taubStart: false)
                } catch {
                    NSLog("[PulseStreamTon] Probe BEITRITT %d FEHLER %@", runde, error.localizedDescription)
                }
                await warten(4); await zeile("\(runde) Kanal mit Mikro")
                if runde == 1 {
                    await r.maschineNeu(grund: "probe")
                    await warten(3); await zeile("1 nach maschineNeu")
                }
                await r.verlassen()
                await warten(3); await zeile("\(runde) nach Verlassen")
            }
            await v.stoppen(kennung: "probe")
            await warten(1); await zeile("ENDE")
        }

        @MainActor private static func js(_ code: String) async -> String {
            for _ in 0 ..< 60 {
                let vc = UIApplication.shared.connectedScenes
                    .compactMap { ($0 as? UIWindowScene)?.windows.first?.rootViewController }
                    .first as? CAPBridgeViewController
                if let web = vc?.bridge?.webView, !web.isLoading {
                    do {
                        let r = try await web.callAsyncJavaScript(code, contentWorld: .page)
                        return "\(r ?? "nil")"
                    } catch {
                        return "JS-FEHLER \(error.localizedDescription)"
                    }
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            return "keine WebView"
        }

        private static func brueckeFahren(url: URL, dauer: Int) async {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            let kopf = await js("""
                const k = (window.Capacitor?.PluginHeaders ?? []).find(h => h.name === 'StreamTonPlugin');
                return k ? k.methods.map(m => m.name).join(',') : 'KEIN KOPF';
                """)
            NSLog("[PulseStreamTon] Probe Brücke Kopf: %@", kopf)
            let start = await js("""
                const z = await Capacitor.nativePromise('StreamTonPlugin', 'starten',
                  { kennung: 'probe-js', url: '\(url.absoluteString)', lautstaerke: 1, echoFaktor: 0.25 });
                return JSON.stringify(z);
                """)
            NSLog("[PulseStreamTon] Probe Brücke starten: %@", start)
            try? await Task.sleep(nanoseconds: UInt64(dauer) * 1_000_000_000)
            let st = await js("""
                const s = await Capacitor.nativePromise('StreamTonPlugin', 'statistik', { kennung: 'probe-js' });
                return JSON.stringify(s);
                """)
            NSLog("[PulseStreamTon] Probe Brücke statistik: %@", st)
            let stopp = await js("""
                await Capacitor.nativePromise('StreamTonPlugin', 'stoppen', { kennung: 'probe-js' });
                return 'ok';
                """)
            NSLog("[PulseStreamTon] Probe Brücke ENDE stoppen=%@ Session: %@", stopp, sessionText())
        }

        private static func sessionText() -> String {
            let s = AVAudioSession.sharedInstance()
            return "kat=\(s.category.rawValue) modus=\(s.mode.rawValue) "
                + "ausKanaele=\(s.outputNumberOfChannels) maxAus=\(s.maximumOutputNumberOfChannels) "
                + "route=\(s.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ","))"
        }
    }
#endif
