import LiveKit
import SwiftUI
import UIKit

#if DEBUG
    /// **Prüfpfad für das Bild-in-Bild des Sprachkanals — nur in
    /// Debug-Bauten** (Muster: `SpracheAnsichtProbe.swift`).
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app \
    ///         [-PulseBildImBildErzwingen YES] \
    ///         -PulseBildImBildProbe "<wsUrl>|<token>|<sekunden>"
    ///
    /// Tritt stumm bei, öffnet die Kanalansicht und schreibt Soll/Ist ins Log
    /// (`[PulseSprache] BildImBildProbe`):
    ///
    /// - ob das Gerät Bild-in-Bild kann, und was der Knopf daraufhin tut —
    ///   am Gerät öffnet er das Fenster, mit `-PulseBildImBildErzwingen` im
    ///   Simulator muss er den Fehlschlag MELDEN;
    /// - jede Sekunde das gewählte Hauptbild (`SpracheHauptbild`) — mit einem
    ///   zweiten Teilnehmer, der erst die Kamera und dann einen Bildschirm
    ///   teilt, muss es von „kamera" auf „schirm" springen;
    /// - ob die Fläche des Fensters über den Sample-Buffer-Weg zeichnet
    ///   (`VideoView.renderMode`, `isRendering`).
    ///
    /// **Das Fenster selbst kann der iPhone-Simulator nicht öffnen**
    /// (`isPictureInPictureSupported()` ist dort `false`, Kopf von
    /// `SpracheBildImBild`). Die Probe legt seinen Inhalt deshalb zusätzlich
    /// als Einblendung oben über die App — ein Bildschirmfoto von aussen
    /// (`xcrun simctl io <sim> screenshot`) zeigt, was im Fenster stünde. Das
    /// belegt Auswahl und Zeichenweg, NICHT das Fenster, den Hintergrund und
    /// das Dekodieren dort.
    enum SpracheBildImBildProbe {
        static func ausStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseBildImBildProbe") else { return }
            let teile = roh.split(separator: "|").map(String.init)
            guard teile.count == 3, let sekunden = Int(teile[2]) else {
                NSLog("[PulseSprache] BildImBildProbe: erwartet \"<wsUrl>|<token>|<sekunden>\"")
                return
            }
            Task { @MainActor in await fahren(wsUrl: teile[0], token: teile[1], sekunden: sekunden) }
        }

        private static func soll(_ was: String, _ ist: Bool) {
            NSLog("[PulseSprache] BildImBildProbe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        @MainActor private static func fahren(wsUrl: String, token: String, sekunden: Int) async {
            let sprache = SpracheRaum.geteilt
            do {
                try await sprache.nacheinander {
                    try await sprache.beitreten(wsUrl: wsUrl, token: token, kanalId: "probe",
                                                kanalName: "Probe-Kanal", stumm: true, taubStart: false)
                }
            } catch {
                NSLog("[PulseSprache] BildImBildProbe Beitritt gescheitert: %@", error.localizedDescription)
                return
            }
            guard let raum = sprache.raum, let wurzel = await SpracheAnsichtProbe.fensterWurzel() else {
                soll("Raum und Fensterwurzel da", false)
                return
            }
            let bild = SpracheBildImBild.geteilt
            NSLog("[PulseSprache] BildImBildProbe isPictureInPictureSupported: %@",
                  bild.unterstuetzt ? "ja" : "nein")
            SpracheAnsichtHalter.geteilt.zeigen(ueber: wurzel, raum: raum, kanalName: "Probe-Kanal",
                                               stil: .dark)
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await controllerBefragen(bild: bild)

            let einblendung = einblenden(raum: raum)
            var letzte = ""
            for s in 0 ..< sekunden {
                let k = SpracheHauptbild.waehlen(in: raum)?.kennung ?? "-"
                if k != letzte {
                    NSLog("[PulseSprache] BildImBildProbe t=%lds Hauptbild %@ (Teilnehmer fern: %ld)",
                          s, k, raum.remoteParticipants.count)
                    letzte = k
                }
                if s % 5 == 4 { zeichenwegMelden(einblendung.view) }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            einblendung.view.removeFromSuperview()
            await sprache.verlassen()
            NSLog("[PulseSprache] BildImBildProbe Ende")
        }

        /// Öffnet das Fenster über den Knopf-Weg. Ohne Unterstützung des Geräts
        /// baut die Probe KEINEN Controller (Absturz, s. `unterstuetzt`) — mit
        /// `-PulseBildImBildErzwingen YES` läuft sie dann den Fehlerweg.
        @MainActor private static func controllerBefragen(bild: SpracheBildImBild) async {
            soll("Knopf sichtbar, genau wenn erzwungen oder unterstützt",
                 bild.knopfZeigen == (bild.unterstuetzt
                     || UserDefaults.standard.bool(forKey: "PulseBildImBildErzwingen")))
            guard bild.knopfZeigen else { return }
            soll("Controller gebaut genau dann, wenn unterstützt", bild.vorbereiten() == bild.unterstuetzt)
            bild.umschalten()
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            NSLog("[PulseSprache] BildImBildProbe nach dem Knopf: aktiv=%@ Fehler=%@",
                  bild.aktiv ? "ja" : "nein", bild.fehler ?? "-")
            soll(bild.unterstuetzt ? "Fenster offen" : "Fehlschlag gemeldet statt verschluckt",
                 bild.unterstuetzt ? bild.aktiv : bild.fehler != nil)
        }

        /// Der Inhalt des Fensters als Einblendung oben über der App.
        @MainActor private static func einblenden(raum: Room) -> UIHostingController<SpracheBildImBildInhalt> {
            let halter = UIHostingController(rootView: SpracheBildImBildInhalt(raum: raum, videoErzwingen: true))
            halter.view.frame = CGRect(x: 16, y: 120, width: 320, height: 180)
            halter.view.layer.cornerRadius = 12
            halter.view.clipsToBounds = true
            UIApplication.shared.sprachSchluesselFenster?.addSubview(halter.view)
            return halter
        }

        @MainActor private static func zeichenwegMelden(_ wurzel: UIView) {
            guard let v = videoView(in: wurzel) else {
                NSLog("[PulseSprache] BildImBildProbe Zeichenweg: keine VideoView (kein Bild gewählt)")
                return
            }
            NSLog("[PulseSprache] BildImBildProbe Zeichenweg renderMode=%@ isRendering=%@ sampleBufferLayer=%@",
                  String(describing: v.renderMode), v.isRendering ? "ja" : "nein",
                  v.avSampleBufferDisplayLayer != nil ? "ja" : "nein")
        }

        @MainActor private static func videoView(in v: UIView) -> VideoView? {
            if let vv = v as? VideoView { return vv }
            for kind in v.subviews { if let vv = videoView(in: kind) { return vv } }
            return nil
        }
    }
#endif
