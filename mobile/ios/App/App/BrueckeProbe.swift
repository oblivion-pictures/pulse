import Capacitor
import Foundation
import UIKit

#if DEBUG
    /// **Prüfpfad für Kette und Brücke (iOS-Bughunt 2 vom 2026-10-11, B5 und
    /// B6) — nur in Debug-Bauten**, ohne LiveKit und ohne Konto:
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app -PulseBrueckeProbe pruefen
    ///     xcrun simctl launch <sim> com.howispulse.app -PulseBrueckeProbe gegenprobe
    ///
    /// **B5:** Befehle, die der Reihe nach von EINER seriellen Warteschlange
    /// kommen (wie Capacitors Brücke), müssen in genau dieser Reihenfolge
    /// laufen. Daneben, nur berichtet und nicht gewertet, der alte Weg (jeder
    /// Befehl aus seinem eigenen `Task`): wie oft er die Reihenfolge verlor.
    ///
    /// **B6:** Ereignisse von fremden Fäden, während auf der Brücke Hörer
    /// kommen und gehen — dieselbe Tabelle, die Capacitor ohne Sperre führt.
    /// `pruefen` meldet über `ereignisMelden` und muss überleben;
    /// `gegenprobe` ruft `notifyListeners` direkt von den fremden Fäden, wie
    /// bis dahin, und zeigt, ob das Rennen in diesem Lauf trifft (ein Absturz
    /// ist dort das erwartete Ergebnis, kein Fehler der Probe).
    ///
    /// Gemeldet wird unter dem Ereignisnamen `probe-b6`, auf den im Web
    /// niemand hört — die Oberfläche bekommt davon nichts.
    enum BrueckeProbe {
        private static let ereignis = "probe-b6"

        static func ausStartargumenten() {
            guard let art = UserDefaults.standard.string(forKey: "PulseBrueckeProbe") else { return }
            Task {
                await reihenfolgePruefen()
                await hoererRennen(gegenprobe: art == "gegenprobe")
                NSLog("[PulseBruecke] Probe ENDE")
            }
        }

        private static func soll(_ was: String, _ ist: Bool) {
            NSLog("[PulseBruecke] Probe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        /// Eine Liste, in die mehrere Fäden schreiben.
        private final class Mitschrift: @unchecked Sendable {
            private let sperre = NSLock()
            private var werte: [Int] = []
            func dazu(_ i: Int) { sperre.lock(); werte.append(i); sperre.unlock() }
            var liste: [Int] { sperre.lock(); defer { sperre.unlock() }; return werte }
        }

        // MARK: - B5

        private static func reihenfolgePruefen() async {
            let n = 400
            let faden = DispatchQueue(label: "com.howispulse.probe.bruecke")
            let neu = Mitschrift()
            let kette = Befehlskette()
            await withCheckedContinuation { (fertig: CheckedContinuation<Void, Never>) in
                faden.async {
                    for i in 0 ..< n {
                        // Ungleich lange Arbeit: wer in der Kette nicht wartet,
                        // überholt hier.
                        kette.einreihen({
                            if i % 5 == 0 { await Task.yield() }
                            neu.dazu(i)
                        }) { _ in
                            if i == n - 1 { fertig.resume() }
                        }
                    }
                }
            }
            soll("B5: \(n) Befehle von einer seriellen Warteschlange laufen in Aufrufreihenfolge",
                 neu.liste == Array(0 ..< n))

            let alt = Mitschrift()
            let alteKette = Befehlskette()
            faden.async {
                for i in 0 ..< n {
                    Task { try? await alteKette.nacheinander { alt.dazu(i) } }
                }
            }
            for _ in 0 ..< 200 where alt.liste.count < n {
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
            let liste = alt.liste
            let vertauscht = zip(liste, liste.dropFirst()).filter { $0 > $1 }.count
            NSLog("[PulseBruecke] Probe ---- B5 Gegenprobe, alter Weg (Task je Befehl): "
                + "%ld von %ld gelaufen, %ld Mal ein späterer vor einem früheren",
                  liste.count, n, vertauscht)
        }

        // MARK: - B6

        private static func plugin() async -> CAPPlugin? {
            for _ in 0 ..< 40 {
                let gefunden: CAPPlugin? = await MainActor.run {
                    let wurzel = UIApplication.shared.connectedScenes
                        .compactMap { ($0 as? UIWindowScene)?.windows.first { $0.isKeyWindow } }
                        .first?.rootViewController as? CAPBridgeViewController
                    return wurzel?.bridge?.plugin(withName: "SprachePlugin")
                }
                if let gefunden { return gefunden }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            return nil
        }

        private static func hoererRennen(gegenprobe: Bool) async {
            guard let p = await plugin() else {
                soll("B6: SprachePlugin über die Brücke gefunden", false)
                return
            }
            guard let bruecke = (p.bridge as? CapacitorBridge)?.dispatchQueue else {
                soll("B6: die Brücken-Warteschlange ist erreichbar (sonst meldet ereignisMelden "
                    + "über den Hauptthread)", false)
                return
            }
            soll("B6: die Brücken-Warteschlange ist erreichbar", true)
            // Erst, wenn die Oberfläche geladen ist: ihr Navigieren räumt die
            // Hörer vom Hauptthread ab (`CapacitorBridge.reset`) — Capacitors
            // eigenes Rennen, das hier nicht gemessen werden soll.
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            let empfangen = Mitschrift()
            let vorbei = Mitschrift()
            // Die Brücke: Hörer kommen und gehen, wie bei jedem
            // `addListener`/`remove()` aus dem Web — bis die Fäden fertig sind.
            // Je Runde gehen die Hörer der vorigen, und neue kommen.
            func hoererWechseln(_ runde: Int, _ alte: [CAPPluginCall]) {
                for h in alte { p.removeEventListener(ereignis, listener: h) }
                guard vorbei.liste.isEmpty else { return }
                let neue = (0 ..< 8).map { k in
                    CAPPluginCall(callbackId: "probe-b6-\(runde)-\(k)", methodName: "addListener",
                                  options: [:], success: { _, _ in empfangen.dazu(1) }, error: { _ in })!
                }
                for h in neue { p.addEventListener(ereignis, listener: h) }
                bruecke.async { hoererWechseln(runde + 1, neue) }
            }
            bruecke.async { hoererWechseln(0, []) }
            // Die fremden Fäden, wie LiveKits Delegaten — je 50 000 Meldungen.
            await withTaskGroup(of: Void.self) { gruppe in
                for faden in 0 ..< 4 {
                    gruppe.addTask {
                        for i in 0 ..< 50_000 {
                            if gegenprobe {
                                p.notifyListeners(ereignis, data: ["faden": faden, "i": i])
                            } else {
                                p.ereignisMelden(ereignis, ["faden": faden, "i": i])
                            }
                        }
                    }
                }
            }
            vorbei.dazu(1)
            // Was über `ereignisMelden` eingereiht ist, läuft danach noch ab.
            await withCheckedContinuation { (fertig: CheckedContinuation<Void, Never>) in
                bruecke.async { fertig.resume() }
            }
            soll("B6 (\(gegenprobe ? "Gegenprobe, alter Weg" : "ereignisMelden")): 200 000 Meldungen "
                + "von vier Fäden neben wechselnden Hörern überlebt, "
                + "\(empfangen.liste.count) Zustellungen", true)
        }
    }
#endif
