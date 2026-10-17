import AVFoundation
import LiveKit

/// **Wie der native Stream-Ton zur Audio-Session kommt — ohne sie je selbst
/// einzustellen.**
///
/// Die Session gehört LiveKit (`AudioSessionEngineObserver`), auch ohne
/// Sprachkanal. Der Stream-Ton meldet bei LiveKit eine Anforderung „nur
/// Wiedergabe" an (`acquireSessionRequirement(.playbackOnly)`, öffentliche
/// API, dasselbe Muster wie LiveKits eigener `SoundPlayer`). Daraus folgt:
///
/// - **Ohne Sprachkanal** stellt LiveKit `.playback` ein und aktiviert. Die
///   Kategorie folgt dem Stummschalter nicht und spielt dank Hintergrund-Audio
///   bei gesperrtem Gerät weiter.
/// - **Mit Sprachkanal** bleibt es bei `.playAndRecord` und dem Modus des
///   Kanals (`selectConfiguration` hängt an Aufnahme/`hasRecorded`, nicht an
///   der Wiedergabe). LiveKit ruft dabei `setCategory` mit denselben Werten —
///   wie bei jedem seiner eigenen Stumm-Wechsel.
/// - **Verlässt man den Kanal, deaktiviert LiveKit die Session NICHT**,
///   solange die Anforderung steht — sonst scheiterte `setActive(false)` an der
///   laufenden Stream-Maschine („busy"), LiveKit rollte seine Buchführung
///   zurück, und der nächste Beitritt sähe keinen Übergang (Kette K2 der
///   Befundakte vom 2026-10-17).
///
/// **Der Preis, und warum es `automatikAus`/`automatikAn` gibt.** Die Hülle
/// heilt eine kaputte Kette, indem sie LiveKit wieder bei „nichts aktiv"
/// anfangen lässt (`SpracheRaum.maschineNeu`, CallKit-Rückgabe): die nächste
/// Anforderung aktiviert die Session dann sicher. Eine dauerhaft gehaltene
/// Anforderung nähme diesen Übergang weg. Deshalb lässt der Stream-Ton sie an
/// genau diesen Stellen los, SOLANGE DIE AUTOMATIK AUS IST (dann fasst LiveKit
/// die Session nicht an — `configureIfNeeded` kehrt sofort zurück), und holt
/// sie zurück, wenn Automatik und Maschine wieder frei sind. Wer zuerst kommt,
/// LiveKits Maschine oder der Stream-Ton, macht den Übergang und aktiviert.
final class StreamTonSitzung: @unchecked Sendable {
    static let geteilt = StreamTonSitzung()

    private let sperre = NSLock()
    private var nutzer = 0
    private var anforderung: SessionRequirementHandle?
    /// Ausgesetzt für die Dauer einer Übergabe (`automatikAus`).
    private var ausgesetzt = false
    /// CallKit führt die Session (`automatikAus(anruf: true)` bis
    /// `automatikAn(grund: "callkit")`). Solange spielt kein Gerät.
    private var anrufFuehrt = false
    /// Sperrt das Übergabe-Fenster gerade die Deaktivierung (`automatikAus`)?
    private var fensterSperrt = false
    /// Gezählte Sperre der Deaktivierung (`deaktivierungSperren`).
    private var sperrTiefe = 0
    private var deaktivierungVorher = true
    /// Wer bei einem Wiederanlauf gefragt wird (die laufenden Geräte).
    var wiederanlauf: ((String) -> Void)?
    /// Wer bei einer CallKit-Übernahme anhalten muss (die laufenden Geräte).
    var anhalten: ((String) -> Void)?

    /// Hält gerade ein Anruf über CallKit die Session? Dann startet kein
    /// Gerät, auch nicht auf „Ton aktivieren" oder beim Vordergrund-Wechsel.
    var anrufHaelt: Bool { sperre.withLock { anrufFuehrt } }

    /// Ein Gerät will spielen. `false`, wenn LiveKit die Session nicht
    /// einrichten konnte — das Gerät bleibt dann unterbrochen.
    func anmelden() -> Bool {
        sperre.lock()
        defer { sperre.unlock() }
        nutzer += 1
        if anforderung == nil, !ausgesetzt {
            do {
                anforderung = try AudioManager.shared.acquireSessionRequirement(.playbackOnly)
            } catch {
                nutzer -= 1
                melden("streamton_session_fehler", ["fehler": "\(error)"])
                return false
            }
        }
        return true
    }

    /// Ein Gerät steht (seine Maschine ist schon angehalten). War es das
    /// letzte, geht die Anforderung zurück, und ohne Raum und Anruf wird die
    /// Session danach deaktiviert (`nachDemLetzten`).
    func abmelden() {
        sperre.lock()
        nutzer = max(0, nutzer - 1)
        let los = nutzer == 0 ? anforderung : nil
        if nutzer == 0 { anforderung = nil }
        sperre.unlock()
        loslassen(los)
        if los != nil { nachDemLetzten() }
    }

    /// **Die Session nach dem letzten Stream-Ton selbst deaktivieren**
    /// (Gegenprüfung 2, V1). Das Loslassen deaktiviert nicht (`loslassen`),
    /// und sonst täte es niemand: LiveKit verbucht „nichts aktiv", `iosTon`
    /// hält die Session dann für aus (`NACH_NATIVEM_RAUM`). Sie blieb aktiv und
    /// mischbar, und ein späterer Beitritt fände eine schon aktive Session vor,
    /// statt sie wie ohne Stream frisch zu aktivieren.
    ///
    /// Nur wenn niemand sonst sie braucht: kein Raum, kein Anruf (auch keiner
    /// über CallKit), kein Stream-Ton mehr, und `iosTon` hat sie nicht für eine
    /// Wiedergabe der WebView eingerichtet (s. unten). „Busy" kann hier nicht
    /// kommen: die eigenen Maschinen stehen, die des SDK läuft ohne Raum nicht.
    /// Ein Fehler wird nur gemeldet — LiveKits Buchführung hängt nicht daran.
    /// Auf dem Hauptthread (die Anruf-Merker leben dort); geprüft und
    /// deaktiviert unter der Sperre, damit kein neues `anmelden` dazwischenfährt.
    /// Auch nach einem Abriss mitten in Bluetooth-HQ (`SpracheFunkHq.nachAbriss`).
    func nachDemLetzten() {
        DispatchQueue.main.async { [self] in
            let v = Anrufverwaltung.geteilt
            guard SpracheRaum.geteilt.raum == nil, AnrufRaum.geteilt.raum == nil,
                  !v.callkitAktiv, !v.ohneCallKit else { return }
            sperre.lock()
            defer { sperre.unlock() }
            let s = AVAudioSession.sharedInstance()
            // `iosTon` richtet für eine Wiedergabe der WebView `.playback` OHNE
            // `.mixWithOthers` ein (`AudioSessionPlugin.setPlaybackMode`) —
            // dann gehört die Session ihm. Alles andere ist ohne Raum und Anruf
            // ein Rest von LiveKit: `.playback` mit `.mixWithOthers` für uns, oder
            // `.playAndRecord`, wenn der Kanal ging, während wir hielten (in der
            // Simulator-Probe gesehen).
            let gehoertIosTon = s.category == .playback && !s.categoryOptions.contains(.mixWithOthers)
            guard nutzer == 0, !gehoertIosTon else { return }
            do {
                try s.setActive(false, options: .notifyOthersOnDeactivation)
                melden("streamton_session_aus", [:])
            } catch {
                melden("streamton_session_aus_fehler", ["fehler": "\(error)"])
            }
        }
    }

    /// Unmittelbar NACH `isAutomaticConfigurationEnabled = false`.
    ///
    /// **`anruf`: CallKit übernimmt** (Gegenprüfung S5). Für LiveKits Maschine
    /// verlangt die Übergabe, dass sie VOR CallKits Aktivierung steht
    /// (`.none`, Kopf von `AnrufSitzung.swift`); eine laufende Stream-Maschine
    /// hielte dagegen Ein-/Ausgabe in der Session, die CallKit gerade
    /// übernimmt, und spielte die Übertragung in den Anruf hinein. Die Geräte
    /// halten deshalb an (ohne sich abzumelden) und laufen erst mit der
    /// Rückgabe wieder an (`automatikAn(grund: "callkit")`).
    func automatikAus(anruf: Bool = false) {
        sperre.lock()
        ausgesetzt = true
        if anruf { anrufFuehrt = true }
        let los = anforderung
        anforderung = nil
        // **Für das ganze Fenster bis `automatikAn` keine Deaktivierung**,
        // solange ein Stream-Ton spielt (Gegenprüfung 2, V2): in dieser Zeit
        // hält LiveKit keine Anforderung von uns. Fiele die der Kanal-Maschine
        // weg (Rauswurf, Abriss während `setMicrophone`), riefe LiveKit
        // `setActive(false)` unter der laufenden Stream-Maschine — „busy",
        // Rückroll, die Mechanik aus S4.
        let sperren = nutzer > 0 && !fensterSperrt
        if sperren { fensterSperrt = true }
        sperre.unlock()
        if sperren { deaktivierungSperren() }
        loslassen(los)
        if anruf { anhalten?("anruf") }
    }

    /// Nachdem Automatik und Maschine wieder frei sind. Hält jemand den Ton,
    /// wird die Anforderung neu gestellt (das ist der Übergang „nichts →
    /// aktiv"), danach laufen unterbrochene Geräte wieder an.
    func automatikAn(grund: String) {
        sperre.lock()
        if grund == "callkit" {
            anrufFuehrt = false
        } else if anrufFuehrt {
            // Ein Beitritt oder der Wächter neben einem CallKit-Anruf: die
            // Session gehört weiter CallKit, die Rückgabe gibt frei.
            sperre.unlock()
            return
        }
        ausgesetzt = false
        var neu = false
        if nutzer > 0, anforderung == nil {
            anforderung = try? AudioManager.shared.acquireSessionRequirement(.playbackOnly)
            neu = anforderung != nil
            if !neu { melden("streamton_session_fehler", ["grund": grund]) }
        }
        let laeuft = nutzer > 0
        let freigeben = fensterSperrt
        fensterSperrt = false
        sperre.unlock()
        // Erst nach dem Zurückholen: dazwischen gäbe es sonst einen Augenblick
        // ohne unsere Anforderung UND mit Deaktivierung.
        if freigeben { deaktivierungFreigeben() }
        if neu { melden("streamton_session_neu", ["grund": grund]) }
        // Nach einem Anruf IMMER: ein Gerät, das während des Anrufs aufging,
        // hat sich nie angemeldet (`starten` bleibt im Anruf vor `anmelden`
        // stehen), `nutzer` zählt es also nicht (Gegenprüfung 2, V3).
        if laeuft || grund == "callkit" { wiederanlauf?(grund) }
    }

    /// **Loslassen deaktiviert nie** (Gegenprüfung S4). Ohne Kanal hiesse das
    /// Loslassen der letzten Anforderung sonst `setActive(false)` — und wirft
    /// das (etwa „busy", 560030580), stellt LiveKit seinen alten Stand wieder
    /// her (`updateRequirements`), während das Handle schon verbraucht ist:
    /// unsere Anforderung bliebe für immer in seiner Buchführung, LiveKit sähe
    /// bis zum Prozessende nie wieder „nichts aktiv", weder zum Aktivieren beim
    /// Beitritt noch zum Deaktivieren — die Klasse K2, nur dauerhaft. Deshalb
    /// ist `isAutomaticDeactivationEnabled` für die Dauer des Loslassens aus.
    /// Deaktiviert wird danach ausdrücklich und nur, wo es niemandem schadet
    /// (`nachDemLetzten`); steht ein Raum, bleibt die Session dessen.
    /// Verlässt der Kanal in genau diesem Augenblick, entfällt auch sein
    /// Deaktivieren — aus demselben Grund harmlos.
    private func loslassen(_ h: SessionRequirementHandle?) {
        guard let h else { return }
        deaktivierungSperren()
        defer { deaktivierungFreigeben() }
        do {
            try h.release()
        } catch {
            melden("streamton_session_loslassen_fehler", ["fehler": "\(error)"])
        }
    }

    /// LiveKits Deaktivierung aus, gezählt: zwei Geräte (je ein eigener Faden)
    /// und das Übergabe-Fenster sperren unabhängig voneinander. Der alte Wert
    /// wird beim ERSTEN Sperren gemerkt und beim LETZTEN Freigeben
    /// zurückgestellt, beides unter der Sperre — sonst konnten zwei
    /// verschränkte „merken → aus → zurück" den Wert für immer auf `false`
    /// lassen (Gegenprüfung 2, Nebenbefund zu S4). Nie unter `sperre` rufen.
    private func deaktivierungSperren() {
        sperre.lock()
        defer { sperre.unlock() }
        if sperrTiefe == 0 {
            let beobachter = AudioManager.shared.audioSession
            deaktivierungVorher = beobachter.isAutomaticDeactivationEnabled
            beobachter.isAutomaticDeactivationEnabled = false
        }
        sperrTiefe += 1
    }

    private func deaktivierungFreigeben() {
        sperre.lock()
        defer { sperre.unlock() }
        sperrTiefe = max(0, sperrTiefe - 1)
        if sperrTiefe == 0 {
            AudioManager.shared.audioSession.isAutomaticDeactivationEnabled = deaktivierungVorher
        }
    }

    private func melden(_ art: String, _ extra: [String: Any]) {
        SpracheRaum.geteilt.diagMelden(art, extra)
    }

    // MARK: - Echo-Lage

    /// **Hört das eigene Mikrofon den Stream-Ton mit?** Der native Stream-Ton
    /// liegt in KEINER Echo-Referenz: nicht in der von WebRTCs Software-AEC
    /// (die sieht nur die Wiedergabe ihrer eigenen Fabrik), und dass Apples
    /// VPIO „other audio" aus dem Mikrofon zieht, sagt Apple nirgends (es
    /// duckt ihn nur — LiveKit-Vorgabe `.min`, fest). Am eingebauten
    /// Lautsprecher, ein paar Zentimeter vom unteren Mikrofon, hörte der Kanal
    /// den Stream deshalb über das Telefon mit. Mit Hörmuschel ist der Weg
    /// leise, mit Kopfhörern weg.
    ///
    /// „Offen" heisst: ein nativer Raum (Kanal oder Anruf) veröffentlicht ein
    /// nicht stummes Mikrofon.
    static func echoLage() -> Bool {
        let route = AVAudioSession.sharedInstance().currentRoute.outputs
        guard route.contains(where: { $0.portType == .builtInSpeaker }) else { return false }
        let sprache = SpracheRaum.geteilt
        if let r = sprache.raum, !sprache.anrufPausiert,
           r.localParticipant.isMicrophoneEnabled() { return true }
        if let r = AnrufRaum.geteilt.raum, r.localParticipant.isMicrophoneEnabled() { return true }
        return false
    }
}
