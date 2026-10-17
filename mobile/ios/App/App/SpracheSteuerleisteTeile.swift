import AVFoundation
import AVKit
import LiveKit
import SwiftUI
import UIKit

// Teile der nativen Steuerleiste, ausgezogen aus `SpracheSteuerleiste.swift`
// (Grössen-Policy, `PLAN.md` §12.1): Haptik, die Ausgabe-Route, der
// System-Routenwähler und die Fehlermeldungen des Fehlerbands.

// MARK: - Haptik

/// Rückmeldung beim Tippen auf einen Knopf der Leiste. **UIKit-Erzeuger statt
/// `.sensoryFeedback`:** das Mindestsystem ist iOS 16.1, die SwiftUI-Fassung
/// gibt es erst ab 17.
///
/// **Ungemessen:** iOS dämpft Haptik und System-Töne, solange die Audio-Session
/// aufnimmt, es sei denn, sie erlaubt sie ausdrücklich
/// (`allowHapticsAndSystemSoundsDuringRecording`). Die Session fasst diese
/// Datei bewusst nicht an — ob die Rückmeldung bei offenem Mikrofon spürbar
/// ist, zeigt erst der Test am Gerät.
enum SpracheHaptik {
    /// Ein Schalter (Mikrofon, Taub, Kamera, Ausgabe, Bild-in-Bild).
    case leicht
    /// Auflegen: deutlicher, es beendet das Gespräch.
    case auflegen

    func ausloesen() {
        switch self {
        case .leicht: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .auflegen: UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        }
    }
}

// MARK: - Runder Knopf

/// Ein runder Knopf der Leiste. **Rund, weil Anruf-Steuerungen rund sind** —
/// dieselbe Begründung wie in `VoiceControlBar.svelte`, und 56 pt ist dort das
/// Mass fürs Telefon (48 pt wäre die Untergrenze der Trefferflächen-Regel).
///
/// **Wächst mit der Schriftgrösse** (`ScaledMetric`), aber nur bis zu einer
/// Obergrenze: ohne sie passten bei den grössten Stufen nicht einmal drei
/// Knöpfe in eine Zeile. Die Leiste weicht vorher auf zwei Zeilen aus.
struct SpracheRundKnopf: View {
    let symbol: String
    let an: Bool
    let warnend: Bool
    var gesperrt = false
    let beschriftung: String
    /// Was das Tippen bewirkt — VoiceOver liest es nach der Beschriftung.
    var hinweis = ""
    let kennung: String
    var haptik: SpracheHaptik = .leicht
    let tun: () -> Void

    @ScaledMetric(relativeTo: .title3) private var flaeche: CGFloat = 56
    @ScaledMetric(relativeTo: .title3) private var zeichen: CGFloat = 22
    @ScaledMetric(relativeTo: .caption) private var schild: CGFloat = 15

    var body: some View {
        let seite = min(flaeche, 84)
        Button {
            haptik.ausloesen()
            tun()
        } label: {
            // Auf Rot und Blau weiss, in Ruhe in der Schriftfarbe des Themas —
            // die dunkle Schrift des hellen Satzes wäre auf Blau unlesbar.
            Image(systemName: symbol)
                .font(.system(size: min(zeichen, 34), weight: .medium))
                .foregroundStyle(warnend || an ? Color.white : SpracheFarben.text)
                .frame(width: seite, height: seite)
                .background(hintergrund, in: Circle())
                .overlay(alignment: .bottomTrailing) {
                    if gesperrt {
                        Image(systemName: "shield.fill")
                            .font(.system(size: min(schild, 24), weight: .bold))
                            .foregroundStyle(SpracheFarben.schild)
                    }
                }
        }
        .disabled(gesperrt)
        .accessibilityLabel(beschriftung)
        .accessibilityHint(hinweis)
        // Für die XCUITests (`AppUITests/UITests.swift`): die Beschriftung
        // ist übersetzt und wechselt mit dem Zustand, die Kennung nicht.
        .accessibilityIdentifier(kennung)
    }

    private var hintergrund: Color {
        if warnend { return SpracheFarben.schlecht }
        return an ? SpracheFarben.marke : SpracheFarben.knopf
    }
}

// MARK: - Ausgabe-Route

/// Wohin der Ton WIRKLICH läuft (`AVAudioSession.currentRoute`), nicht was der
/// Nutzer gewünscht hat. Der Lautsprecher-Knopf richtet sich danach: läuft der
/// Ton über Bluetooth oder Kopfhörer, wäre ein Umschalten zwischen Hörmuschel
/// und Lautsprecher wirkungslos (iOS lässt die externe Route gewinnen).
/// Fortgeschrieben wird sie über `routeChangeNotification` (die Leiste
/// abonniert sie).
struct SpracheAusgabe: Equatable {
    enum Art { case eingebaut, bluetooth, kabel, extern }

    let art: Art
    let name: String
    private let airPlay: Bool

    static func aktuell() -> SpracheAusgabe {
        guard let aus = AVAudioSession.sharedInstance().currentRoute.outputs.first else {
            return SpracheAusgabe(art: .eingebaut, name: "", airPlay: false)
        }
        let art: Art
        switch aus.portType {
        case .builtInSpeaker, .builtInReceiver: art = .eingebaut
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE: art = .bluetooth
        case .headphones, .usbAudio, .lineOut: art = .kabel
        default: art = .extern // AirPlay, Auto, HDMI …
        }
        return SpracheAusgabe(art: art, name: aus.portName, airPlay: aus.portType == .airPlay)
    }

    /// Das Zeichen der externen Route; `nil` bei den eingebauten (dort
    /// wählt der Knopf selbst zwischen Lautsprecher und Hörmuschel).
    var symbol: String? {
        switch art {
        case .eingebaut: return nil
        case .bluetooth: return name.localizedCaseInsensitiveContains("AirPods") ? "airpods" : "headphones"
        case .kabel: return "headphones"
        case .extern: return airPlay ? "airplayaudio" : "speaker.wave.2.circle.fill"
        }
    }

    var beschriftung: String {
        name.isEmpty
            ? NSLocalizedString("Tonausgabe wählen", comment: "Sprachkanal")
            : String(format: NSLocalizedString("Tonausgabe: %@ — antippen zum Wählen", comment: "Sprachkanal"), name)
    }
}

/// Der System-Routenwähler (`AVRoutePickerView`), unsichtbar eingehängt und
/// per Zähler ausgelöst: das System hat keinen Aufruf dafür, nur diese Ansicht
/// samt Knopf. **Am Gerät zu belegen:** ob der ausgelöste Knopf bei dieser
/// Bauweise das Blatt öffnet (im Simulator gibt es keine Routen).
struct SpracheRoutenWaehler: UIViewRepresentable {
    let ausloeser: Int

    final class Merker { var zuletzt = 0 }

    func makeCoordinator() -> Merker { Merker() }

    func makeUIView(context _: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.alpha = 0.02
        v.isUserInteractionEnabled = false
        v.isAccessibilityElement = false
        return v
    }

    func updateUIView(_ v: AVRoutePickerView, context: Context) {
        guard ausloeser != context.coordinator.zuletzt else { return }
        context.coordinator.zuletzt = ausloeser
        v.subviews.compactMap { $0 as? UIButton }.first?.sendActions(for: .touchUpInside)
    }
}

// MARK: - Meldungen des Fehlerbands

/// Eine Zeile im Fehlerband der Kanalansicht. **Verständliches Deutsch statt
/// des SDK-Texts** (`LiveKitError` liefert englische Kürzel wie
/// „deviceAccessDenied"); die Rohfassung steht weiter im Log
/// (`SpracheSteuerleiste.gemeldet`). `id` macht jede Meldung einzigartig, damit
/// derselbe Text den Ablauf-Zeitgeber neu startet.
struct SpracheMeldung: Equatable {
    let id = UUID()
    let text: String
    /// Hilft nur ein Gang in die iOS-Einstellungen (verweigerte Erlaubnis)?
    /// Dann bietet das Band den Knopf dafür an und bleibt stehen, bis eine
    /// Aktion gelingt oder der Nutzer „OK" tippt.
    var einstellungen = false

    /// `knopf`: `mikrofon`, `taub`, `kamera`, `kameraSeite`, `auflegen`.
    static func aus(_ fehler: Error, knopf: String) -> SpracheMeldung {
        let art = (fehler as? LiveKitError)?.type
        let kamera = knopf == "kamera" || knopf == "kameraSeite"
        func verweigert(_ typ: AVMediaType) -> Bool {
            let s = AVCaptureDevice.authorizationStatus(for: typ)
            return s == .denied || s == .restricted
        }
        if kamera, art == .deviceAccessDenied || verweigert(.video) {
            return SpracheMeldung(
                text: NSLocalizedString(
                    "Pulse darf die Kamera nicht benutzen. Erlaube den Zugriff in den Einstellungen.",
                    comment: "Sprachkanal"),
                einstellungen: true)
        }
        if knopf == "mikrofon", art == .deviceAccessDenied || verweigert(.audio) {
            return SpracheMeldung(
                text: NSLocalizedString(
                    "Pulse darf das Mikrofon nicht benutzen. Erlaube den Zugriff in den Einstellungen.",
                    comment: "Sprachkanal"),
                einstellungen: true)
        }
        if art == .deviceNotFound {
            return SpracheMeldung(text: kamera
                ? NSLocalizedString("Auf diesem Gerät wurde keine Kamera gefunden.", comment: "Sprachkanal")
                : NSLocalizedString("Auf diesem Gerät wurde kein Mikrofon gefunden.", comment: "Sprachkanal"))
        }
        if art == .network || art == .timedOut {
            return SpracheMeldung(text: NSLocalizedString(
                "Keine Verbindung zum Server. Versuche es gleich noch einmal.", comment: "Sprachkanal"))
        }
        switch knopf {
        case "mikrofon":
            return SpracheMeldung(text: NSLocalizedString(
                "Das Mikrofon konnte nicht umgeschaltet werden. Versuche es noch einmal.", comment: "Sprachkanal"))
        case "taub":
            return SpracheMeldung(text: NSLocalizedString(
                "Das Mithören konnte nicht umgeschaltet werden. Versuche es noch einmal.", comment: "Sprachkanal"))
        case "kamera":
            return SpracheMeldung(text: NSLocalizedString(
                "Die Kamera konnte nicht umgeschaltet werden. Versuche es noch einmal.", comment: "Sprachkanal"))
        case "kameraSeite":
            return SpracheMeldung(text: NSLocalizedString(
                "Die Kamera konnte nicht gewechselt werden. Versuche es noch einmal.", comment: "Sprachkanal"))
        case "auflegen":
            return SpracheMeldung(text: NSLocalizedString(
                "Auflegen hat nicht geklappt. Versuche es noch einmal.", comment: "Sprachkanal"))
        default:
            return SpracheMeldung(text: NSLocalizedString(
                "Das hat nicht geklappt. Versuche es noch einmal.", comment: "Sprachkanal"))
        }
    }
}

/// Was die Ansicht beobachten muss, das kein `ObservableObject` des SDK
/// trägt: `taub` lebt in der Hülle (`SpracheRaum.taub`), die
/// Admin-Stummschaltung im Web (`SprachePlugin.erzwungen`). Geschrieben nur auf
/// dem Hauptthread.
final class SpracheStand: ObservableObject {
    static let geteilt = SpracheStand()
    @Published var taub = false
    /// Der Mikrofon-Wächter hat aufgegeben (`SpracheMikroWache.swift`) — die
    /// Ansicht zeigt dann ein Band mit „Erneut verbinden".
    @Published var mikroTot = false
    /// Kennt die Web-App „Erneut verbinden" aus der Ansicht? Eine ältere
    /// übergeht die Aktion — dann zeigt das Band statt des Knopfs den Rat,
    /// die App neu zu starten (Gegenprüfung T7). Gesetzt je Beitritt.
    @Published var neuVerbindenMoeglich = false
    /// Nutzer-Ids, die die Moderation im Kanal stumm- beziehungsweise
    /// taubgeschaltet hat. **Nur Anzeige** (Schild, gesperrter Knopf): LiveKit
    /// kennt die Stummschaltung bloss als entzogenes Recht und die
    /// Taubschaltung gar nicht — die Wahrheit hat das Web
    /// (`web/src/lib/voice/erzwungen.ts`).
    @Published private(set) var erzwungenStumm: Set<String> = []
    @Published private(set) var erzwungenTaub: Set<String> = []

    func erzwungenSetzen(stumm: Set<String>, taub: Set<String>) {
        if erzwungenStumm != stumm { erzwungenStumm = stumm }
        if erzwungenTaub != taub { erzwungenTaub = taub }
    }

    /// Stumm- und Taubschaltung durch die Moderation für einen Teilnehmer.
    func erzwungen(fuer p: Participant) -> (stumm: Bool, taub: Bool) {
        guard let nutzer = SpracheRaum.nutzerId(aus: p.identity?.stringValue ?? "") else {
            return (false, false)
        }
        return (erzwungenStumm.contains(nutzer), erzwungenTaub.contains(nutzer))
    }
}
