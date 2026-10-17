import LiveKit
import SwiftUI
import UIKit

/// Welches Bild des Kanals ins Bild-in-Bild gehört — „die gerade grosse
/// Kachel", nach Inhalt statt nach Lage bestimmt: die Kanalansicht kennt keine
/// grosse Kachel (bis zwei Kacheln eine Spalte, darüber ein Raster), das
/// Fenster aber hat nur Platz für eine.
///
/// **Die Reihenfolge, und warum:**
/// 1. Eine Bildschirmfreigabe — wer teilt, zeigt das, worum es geht; teilen
///    zwei, die desjenigen, der zuletzt sprach.
/// 2. Die Kamera dessen, der zuletzt sprach.
/// 3. Irgendeine Kamera.
/// 4. Ohne Bild: Name und Sprechring dessen, der zuletzt sprach.
///
/// Nur FERNE Teilnehmer — das eigene Gesicht im Fenster hilft niemandem; nur
/// wer allein im Kanal ist, sieht sich selbst. „Zuletzt sprach" statt
/// „spricht gerade", damit das Fenster nicht bei jedem Atemzug eines anderen
/// umspringt.
struct SpracheHauptbild {
    let teilnehmer: Participant
    let video: VideoTrack?
    let istBildschirm: Bool

    /// Stabil, solange dasselbe Bild gewählt bleibt — die Ansicht baut nur bei
    /// einem Wechsel neu.
    var kennung: String {
        let art: String
        if istBildschirm {
            art = "schirm"
        } else if video != nil {
            art = "kamera"
        } else {
            art = "name"
        }
        return (teilnehmer.identity?.stringValue ?? "?") + "|" + art
    }

    static func waehlen(in raum: Room) -> SpracheHauptbild? {
        let fern = Array(raum.remoteParticipants.values)
        guard !fern.isEmpty else {
            let ich = raum.localParticipant
            return SpracheHauptbild(teilnehmer: ich, video: ich.firstCameraVideoTrack, istBildschirm: false)
        }
        // Zuletzt gesprochen zuerst; wer nie sprach, nach Kennung — stabil.
        let reihe = fern.sorted { a, b in
            switch (a.lastSpokeAt, b.lastSpokeAt) {
            case let (x?, y?): return x > y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return (a.identity?.stringValue ?? "") < (b.identity?.stringValue ?? "")
            }
        }
        if let p = reihe.first(where: { $0.firstScreenShareVideoTrack != nil }) {
            return SpracheHauptbild(teilnehmer: p, video: p.firstScreenShareVideoTrack, istBildschirm: true)
        }
        if let p = reihe.first(where: { $0.firstCameraVideoTrack != nil }) {
            return SpracheHauptbild(teilnehmer: p, video: p.firstCameraVideoTrack, istBildschirm: false)
        }
        return SpracheHauptbild(teilnehmer: reihe[0], video: nil, istBildschirm: false)
    }

    /// Lohnt ein Fenster, das von selbst aufgeht? Nur, wenn jemand ein Bild
    /// zeigt oder gerade spricht.
    static func lohntSich(_ raum: Room) -> Bool {
        raum.remoteParticipants.values.contains {
            $0.firstScreenShareVideoTrack != nil || $0.firstCameraVideoTrack != nil || $0.isSpeaking
        }
    }
}

/// Was im Bild-in-Bild-Fenster steht. Beobachtet den Raum selbst (wie
/// `SpracheAnsicht`), damit ein Wechsel des Hauptbilds nicht über die Brücke
/// muss.
struct SpracheBildImBildInhalt: View {
    @ObservedObject var raum: Room
    @ObservedObject private var bild = SpracheBildImBild.geteilt
    /// Für die Probe im Simulator: zeichnet das Video auch ohne Fenster.
    var videoErzwingen = false

    var body: some View {
        ZStack {
            Color.black
            if let h = SpracheHauptbild.waehlen(in: raum) {
                SpracheBildImBildFlaeche(teilnehmer: h.teilnehmer,
                                         video: (bild.zeigtVideo || videoErzwingen) ? h.video : nil,
                                         istBildschirm: h.istBildschirm)
                    .id(h.kennung)
            }
        }
        .ignoresSafeArea()
    }
}

/// Eine Fläche im Fenster: Video oder Name, darüber Name und Sprechring.
private struct SpracheBildImBildFlaeche: View {
    @ObservedObject var teilnehmer: Participant
    let video: VideoTrack?
    let istBildschirm: Bool

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let video {
                // **`.sampleBuffer`, nicht `.auto`:** auf neueren Geräten wählt
                // `.auto` Metal, und das darf im Hintergrund nicht zeichnen —
                // genau dort lebt dieses Fenster (Begründung im Kopf von
                // `SpracheBildImBild`).
                SwiftUIVideoView(video, layoutMode: istBildschirm ? .fit : .fill,
                                 mirrorMode: .off, renderMode: .sampleBuffer)
            } else {
                Circle()
                    .fill(SpracheFarben.marke.opacity(0.35))
                    .overlay(Text(teilnehmer.spracheKuerzel).font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(SpracheFarben.aufBild))
                    .frame(width: 84, height: 84)
                    .overlay(Circle().strokeBorder(SpracheFarben.gut,
                                                   lineWidth: teilnehmer.isSpeaking ? 4 : 0))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Text(teilnehmer.spracheAnzeigename)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(SpracheFarben.aufBild)
                .lineLimit(1)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.black.opacity(0.55), in: Capsule())
                .padding(8)
        }
        .overlay(
            Rectangle().strokeBorder(SpracheFarben.gut, lineWidth: video != nil && teilnehmer.isSpeaking ? 3 : 0)
        )
    }
}

/// Der Knopf in der Kopfzeile der Kanalansicht: Tipp öffnet oder schliesst
/// das Fenster, langes Drücken bietet das Automatische an. Erscheint nur, wo
/// das Gerät Bild-in-Bild kann.
struct SpracheBildImBildKnopf: View {
    @ObservedObject private var bild = SpracheBildImBild.geteilt
    let fehlerMelden: (String) -> Void
    @ScaledMetric(relativeTo: .headline) private var flaeche: CGFloat = 44

    var body: some View {
        if bild.knopfZeigen {
            Menu {
                Toggle(isOn: $bild.automatisch) {
                    Label(NSLocalizedString(
                        "Bild-in-Bild beim Verlassen der App automatisch starten", comment: "Sprachkanal"),
                          systemImage: "rectangle.portrait.and.arrow.right")
                }
                .accessibilityHint(NSLocalizedString(
                    "Startet Bild-in-Bild von selbst, wenn du Pulse verlässt, solange du im Sprachkanal bist.",
                    comment: "Sprachkanal"))
            } label: {
                Image(systemName: bild.aktiv ? "pip.exit" : "pip.enter")
                    .font(.headline)
                    .foregroundStyle(SpracheFarben.text)
                    .frame(width: min(flaeche, 64), height: min(flaeche, 64))
            } primaryAction: {
                SpracheHaptik.leicht.ausloesen()
                bild.umschalten()
            }
            .accessibilityLabel(bild.aktiv
                ? NSLocalizedString("Bild-in-Bild beenden", comment: "Sprachkanal")
                : NSLocalizedString("Bild-in-Bild", comment: "Sprachkanal"))
            .accessibilityHint(NSLocalizedString(
                "Tippen schaltet um. Gedrückt halten für Optionen.", comment: "Sprachkanal"))
            .onChange(of: bild.fehler) { neu in
                if let neu { fehlerMelden(neu) }
            }
        }
    }
}

/// Meldet die Kachelfläche der Kanalansicht als Quelle des Fensters — es
/// wächst dann aus ihr heraus und kehrt dorthin zurück. Fällt sie weg (Ansicht
/// geschlossen), nimmt `SpracheBildImBild` die Wurzel der App.
struct SpracheBildImBildAnker: UIViewRepresentable {
    func makeUIView(context _: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        DispatchQueue.main.async { SpracheBildImBild.geteilt.quelleSetzen(v) }
        return v
    }

    func updateUIView(_: UIView, context _: Context) {}

    static func dismantleUIView(_ v: UIView, coordinator _: ()) {
        DispatchQueue.main.async { SpracheBildImBild.geteilt.quelleWeg(v) }
    }
}
