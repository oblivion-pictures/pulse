import AVKit
import LiveKit
import SwiftUI
import UIKit

/// System-Bild-in-Bild für den nativen Sprachkanal (iOS-Roadmap Punkt 29):
/// ein Fenster des Systems, das über anderen Apps stehen bleibt — mit dem
/// Hauptbild des Kanals (`SpracheHauptbild`), nicht mit einer festen Kachel.
///
/// **Der Weg ist Apples Videoanruf-Bild-in-Bild** (ab iOS 15):
/// `AVPictureInPictureController` mit einer `ContentSource` aus
/// `activeVideoCallSourceView` und einem `AVPictureInPictureVideoCallViewController`.
/// LiveKit 2.17.0 bringt dafür nichts Eigenes mit — am Quelltext gesucht, kein
/// `AVPictureInPicture` im ganzen Paket. Was es mitbringt und hier reicht:
/// `VideoView.RenderMode.sampleBuffer` (`SampleBufferVideoRenderer`, ein
/// `AVSampleBufferDisplayLayer`). Das Fenster zeichnet nur über diesen Weg
/// (`SpracheBildImBildInhalt`), nicht über Metal: eine App im Hintergrund darf
/// keine GPU-Arbeit abschicken (Apple-Doku, hier nicht gemessen), und das SDK
/// weicht aus genau diesem Grund an seinen eigenen GPU-Stellen auf die CPU
/// aus (CHANGELOG 2.x: „avoid GPU crash when app is backgrounded during
/// PiP", `BroadcastImageCodec`).
///
/// **Was belegt ist und was nicht.** Im iPhone-Simulator (iOS 26.3) liefert
/// `AVPictureInPictureController.isPictureInPictureSupported()` `false` — das
/// Profil des simulierten iPhones schaltet es ab (`PiPOverlay = 0` in seinen
/// `capabilities.plist`, beim iPad steht dort `1`). Der Knopf erscheint dort
/// deshalb nicht, und ob das Fenster am Telefon wirklich aufgeht, im
/// Hintergrund weiterzeichnet und die Fernspuren dekodiert, ist NUR am Gerät
/// zu klären. Geprüft im Simulator ist der Inhalt (`SpracheBildImBildProbe`).
///
/// **Hintergrund-Fähigkeit:** Apples Bild-in-Bild verlangt laut Doku die
/// Fähigkeit „Audio, AirPlay, and Picture in Picture" — das ist der Eintrag
/// `audio` in `UIBackgroundModes`, und der steht seit Punkt 23 drin. `voip`
/// (Punkt 40, PushKit) ist dafür nicht gefragt. Dass die App mit offenem
/// Fenster im Hintergrund weiterläuft, trägt dieselbe aktive Audio-Session,
/// die den Sprachkanal heute schon im Hintergrund hörbar hält — am Gerät zu
/// bestätigen, ebenso, ob die Fernspuren dort weiter dekodiert werden.
@MainActor
final class SpracheBildImBild: NSObject, ObservableObject {
    static let geteilt = SpracheBildImBild()

    /// Kann dieses Gerät Bild-in-Bild? **Vor jedem Bau eines Controllers zu
    /// prüfen, ohne Ausnahme:** `AVPictureInPictureController(contentSource:)`
    /// liefert auf einem Gerät ohne Bild-in-Bild `nil`, obwohl Swift den
    /// Initialisierer als nicht-optional einliest. Am 2026-10-11 im Simulator
    /// genau so abgestürzt („Found a null pointer in a value of type
    /// 'AVPictureInPictureController'"), beim ersten Zugriff über KVO.
    let unterstuetzt = AVPictureInPictureController.isPictureInPictureSupported()

    /// Zeigt die Kanalansicht den Knopf? Gleich `unterstuetzt` — ausser in
    /// Debug-Bauten mit dem Startargument `-PulseBildImBildErzwingen YES`: im
    /// iPhone-Simulator die einzige Art, Knopf, Menü und den Weg eines
    /// Fehlschlags anzusehen. Ein Fenster entsteht davon nicht (`vorbereiten`
    /// fragt `unterstuetzt`).
    #if DEBUG
        var knopfZeigen: Bool {
            unterstuetzt || UserDefaults.standard.bool(forKey: "PulseBildImBildErzwingen")
        }
    #else
        var knopfZeigen: Bool { unterstuetzt }
    #endif

    /// Das Fenster steht.
    @Published private(set) var aktiv = false
    /// Es geht gerade auf — ab hier zeichnet der Inhalt Video (s. `zeigtVideo`).
    @Published private(set) var anlauf = false
    /// Warum der letzte Start scheiterte. Die Ansicht zeigt ihn an.
    @Published private(set) var fehler: String?

    /// **Beim Verlassen der App von selbst starten.** Vorgabe AUS: ob das
    /// automatisch geschehen soll oder nur per Knopf, ist eine
    /// Eigentümer-Entscheidung (gemeldet mit Punkt 29); gebaut ist der Knopf,
    /// das Automatische nur als Option.
    @Published var automatisch: Bool {
        didSet {
            UserDefaults.standard.set(automatisch, forKey: Self.automatischSchluessel)
            if automatisch { vorbereiten() }
            automatikStellen()
        }
    }
    static let automatischSchluessel = "pulse.sprache.bildImBildAutomatisch"

    private static var nichtMoeglich: String {
        NSLocalizedString("Bild-in-Bild ist gerade nicht möglich.", comment: "Sprachkanal")
    }

    /// Zeichnet der Inhalt Video? Nur im Fenster — vorher bliebe eine
    /// `VideoView` ohne Fenster an der Spur hängen und rechnete jedes Bild um
    /// (`shouldRender` fragt nicht nach einem Fenster).
    var zeigtVideo: Bool { aktiv || anlauf }

    private weak var raum: Room?
    private var steuerung: AVPictureInPictureController?
    private var inhalt: AVPictureInPictureVideoCallViewController?
    /// Die Kanalansicht meldet hier ihre Kachelfläche (`SpracheBildImBildAnker`).
    /// Ohne sie geht das Fenster aus der Wurzel der App auf.
    private weak var ansichtsQuelle: UIView?
    private var startWunsch = false
    private var moeglichBeobachtung: NSKeyValueObservation?

    override init() {
        automatisch = UserDefaults.standard.bool(forKey: Self.automatischSchluessel)
        super.init()
        // **Hier und nicht im Takt:** ob es etwas zu zeigen gibt, wird in dem
        // Moment entschieden, in dem man die App verlässt. AVKit liest den
        // Schalter erst beim Übergang in den Hintergrund, und `willResignActive`
        // kommt davor.
        NotificationCenter.default.addObserver(
            self, selector: #selector(gleichWeg),
            name: UIApplication.willResignActiveNotification, object: nil)
    }

    // MARK: - Raum

    /// Ein Raum steht. Gebaut wird der Controller erst, wenn er gebraucht wird
    /// — beim ersten Knopfdruck oder wenn das Automatische an ist.
    func raumDa(_ r: Room) {
        guard unterstuetzt, raum !== r else { return }
        abbauen()
        raum = r
        if automatisch { vorbereiten() }
    }

    /// Der Raum ist weg — das Fenster geht mit. Nur für genau diesen Raum: ein
    /// verspäteter Ruf darf den eines neueren Beitritts nicht abräumen.
    func raumWeg(_ r: Room) {
        guard raum === r else { return }
        steuerung?.stopPictureInPicture()
        abbauen()
        raum = nil
    }

    private func abbauen() {
        moeglichBeobachtung = nil
        steuerung = nil
        inhalt = nil
        startWunsch = false
        aktiv = false
        anlauf = false
    }

    // MARK: - Quelle

    /// Die Kanalansicht meldet ihre Kachelfläche. Die Quelle ist nur der Ort,
    /// aus dem das Fenster herauswächst; ohne sie wäre es gar nicht möglich,
    /// deshalb fällt sie auf die Wurzel der App zurück, solange die Ansicht zu
    /// ist.
    func quelleSetzen(_ v: UIView) {
        ansichtsQuelle = v
        quelleAnwenden()
    }

    /// Nur, wenn `v` noch die gemeldete ist — eine neu aufgebaute Ansicht kann
    /// sich schon gemeldet haben, bevor die alte abgebaut ist.
    func quelleWeg(_ v: UIView) {
        guard ansichtsQuelle === v else { return }
        ansichtsQuelle = nil
        quelleAnwenden()
    }

    private func quelleAnwenden() {
        guard let steuerung, let inhalt, let q = quelleJetzt() else { return }
        steuerung.contentSource = .init(activeVideoCallSourceView: q, contentViewController: inhalt)
    }

    private func quelleJetzt() -> UIView? {
        if let v = ansichtsQuelle, v.window != nil { return v }
        return UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.windows.first { $0.isKeyWindow } }
            .first?.rootViewController?.view
    }

    // MARK: - Steuern

    /// Baut Inhalt und Controller, falls noch nicht geschehen. Gibt an, ob es
    /// jetzt einen gibt.
    @discardableResult
    func vorbereiten() -> Bool {
        if steuerung != nil { return true }
        guard unterstuetzt, let raum, let q = quelleJetzt() else { return false }
        let vc = AVPictureInPictureVideoCallViewController()
        vc.preferredContentSize = CGSize(width: 1600, height: 900)
        let halter = UIHostingController(rootView: SpracheBildImBildInhalt(raum: raum))
        halter.view.backgroundColor = .black
        halter.view.frame = vc.view.bounds
        halter.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        vc.addChild(halter)
        vc.view.addSubview(halter.view)
        halter.didMove(toParent: vc)
        let s = AVPictureInPictureController(
            contentSource: .init(activeVideoCallSourceView: q, contentViewController: vc))
        s.delegate = self
        moeglichBeobachtung = s.observe(\.isPictureInPicturePossible, options: [.new]) {
            [weak self] beobachtet, _ in
            let moeglich = beobachtet.isPictureInPicturePossible
            Task { @MainActor in self?.moeglichGeaendert(moeglich) }
        }
        inhalt = vc
        steuerung = s
        automatikStellen()
        return true
    }

    /// Knopf: auf, oder zu, wenn es schon steht.
    func umschalten() {
        fehler = nil
        if aktiv {
            steuerung?.stopPictureInPicture()
            return
        }
        guard vorbereiten(), let steuerung else {
            fehler = Self.nichtMoeglich
            return
        }
        if steuerung.isPictureInPicturePossible {
            steuerung.startPictureInPicture()
            return
        }
        // Frisch gebaut meldet der Controller „möglich" erst einen Augenblick
        // später — der Wunsch wartet darauf, aber nicht unbegrenzt.
        startWunsch = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.startWunsch else { return }
            self.startWunsch = false
            self.fehler = Self.nichtMoeglich
        }
    }

    private func moeglichGeaendert(_ moeglich: Bool) {
        guard moeglich, startWunsch, let steuerung else { return }
        startWunsch = false
        steuerung.startPictureInPicture()
    }

    @objc private func gleichWeg() { automatikStellen() }

    /// Automatisch nur, wenn die Option an ist UND gerade jemand spricht oder
    /// ein Bild zeigt — ein stiller Kanal ohne Bild soll kein Fenster öffnen.
    private func automatikStellen() {
        guard let steuerung else { return }
        let jetzt = automatisch && (raum.map(SpracheHauptbild.lohntSich) ?? false)
        if steuerung.canStartPictureInPictureAutomaticallyFromInline != jetzt {
            steuerung.canStartPictureInPictureAutomaticallyFromInline = jetzt
        }
    }
}

extension SpracheBildImBild: AVPictureInPictureControllerDelegate {
    nonisolated func pictureInPictureControllerWillStartPictureInPicture(
        _: AVPictureInPictureController) {
        Task { @MainActor in self.anlauf = true }
    }

    nonisolated func pictureInPictureControllerDidStartPictureInPicture(
        _: AVPictureInPictureController) {
        NSLog("[PulseSprache] Bild-in-Bild offen")
        Task { @MainActor in
            self.aktiv = true
            self.anlauf = false
        }
    }

    nonisolated func pictureInPictureController(
        _: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        NSLog("[PulseSprache] Bild-in-Bild gescheitert: %@", error.localizedDescription)
        Task { @MainActor in
            self.anlauf = false
            self.aktiv = false
            self.fehler = error.localizedDescription
        }
    }

    nonisolated func pictureInPictureControllerDidStopPictureInPicture(
        _: AVPictureInPictureController) {
        NSLog("[PulseSprache] Bild-in-Bild zu")
        Task { @MainActor in
            self.aktiv = false
            self.anlauf = false
        }
    }

    /// „Zurück zur App" im Fenster. **Die Kanalansicht wird dabei NICHT
    /// geöffnet:** ob sie steht, entscheidet die Web-Route (Entwurf §5); die
    /// Sprachleiste bietet den Griff zurück in den Kanal an.
    nonisolated func pictureInPictureController(
        _: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler fertig:
            @escaping (Bool) -> Void) {
        fertig(true)
    }
}
