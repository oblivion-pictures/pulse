import Foundation
import LiveKit

#if DEBUG
    /// **Prüfpfad für den Begrenzer am Ende der Wiedergabe — nur in
    /// Debug-Bauten** (Muster: `SprachePluginProbe.swift`).
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app \
    ///         -PulseBegrenzerProbe "<wsUrl>|<token>|<sekunden>"
    ///
    /// Tritt stumm bei, hängt den Begrenzer über denselben Weg ein wie der
    /// Brückenbefehl `lautstaerken` (`hoerwunschSetzen(begrenzer:)`) und
    /// schreibt jede Sekunde die lauteste Probe VOR und NACH ihm ins Log
    /// (dBFS), dann hängt er ihn aus. Braucht einen zweiten Teilnehmer mit
    /// Tonspur im Raum — mit einem Ton über -6 dBFS muss „nach" knapp über
    /// der Schwelle liegen, mit einem leisen gleich „vor". Gemessen am
    /// 2026-10-11 im Simulator mit einem Sinus (440 Hz, im Wechsel laut und
    /// leise): -0,4 → -5,0 dBFS und -13,9 → -13,9 dBFS. Dass „nach" etwas über
    /// den gerechneten -5,7 liegt, erklärt die Hüllkurve, die sich zwischen
    /// zwei Wellenbergen ein Stück erholt (gefolgert, nicht einzeln
    /// gemessen). In der Sekunde mit dem Sprung von leise auf laut stand -1,2:
    /// die ersten Millisekunden, bevor der Anstieg greift — ohne Vorschau.
    ///
    /// Belegt wird damit, dass das SDK den Begrenzer in die Wiedergabe hängt,
    /// ihn mit echtem Ton aufruft und was er am Puffer tut. Dass der
    /// bearbeitete Puffer auch das ist, was der Lautsprecher spielt, sagt der
    /// Doc-Kommentar des SDK („before it is played to the user"), nicht diese
    /// Probe — hören lässt es sich nur am Gerät.
    enum WiedergabebegrenzerProbe {
        static func ausStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseBegrenzerProbe") else { return }
            let teile = roh.split(separator: "|").map(String.init)
            guard teile.count == 3, let sekunden = Int(teile[2]) else {
                NSLog("[PulseSprache] BegrenzerProbe: erwartet \"<wsUrl>|<token>|<sekunden>\"")
                return
            }
            Task { await fahren(wsUrl: teile[0], token: teile[1], sekunden: sekunden) }
        }

        private static func dbfs(_ wert: Float) -> String {
            guard wert > 0 else { return "still" }
            return String(format: "%.1f dBFS", 20 * log10f(wert / Wiedergabebegrenzer.vollaussteuerung))
        }

        private static func fahren(wsUrl: String, token: String, sekunden: Int) async {
            let sprache = SpracheRaum.geteilt
            do {
                try await sprache.nacheinander {
                    try await sprache.beitreten(wsUrl: wsUrl, token: token, kanalId: "probe",
                                                kanalName: "Probe-Kanal", stumm: true, taubStart: false)
                }
            } catch {
                NSLog("[PulseSprache] BegrenzerProbe BEITRITT fehlgeschlagen: %@",
                      error.localizedDescription)
                return
            }
            await sprache.hoerwunschSetzen(je: nil, gesamt: nil, begrenzer: true)
            let b = Wiedergabebegrenzer.geteilt
            NSLog("[PulseSprache] BegrenzerProbe eingehängt: %@",
                  AudioManager.shared.renderPreProcessingDelegate === b ? "ja" : "NEIN")
            for s in 1 ... max(sekunden, 1) {
                b.spitzeEin = 0
                b.spitzeAus = 0
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                NSLog("[PulseSprache] BegrenzerProbe %2ld s: vor %@, nach %@", s,
                      dbfs(b.spitzeEin), dbfs(b.spitzeAus))
            }
            await sprache.hoerwunschSetzen(je: nil, gesamt: nil, begrenzer: false)
            NSLog("[PulseSprache] BegrenzerProbe ausgehängt: %@",
                  AudioManager.shared.renderPreProcessingDelegate == nil ? "ja" : "NEIN")
            await sprache.verlassen()
        }
    }
#endif
