import AVFoundation
import CallKit
import LiveKit

/// Was der Raum tut, um die Audio-Kette WIEDER herzustellen — beim Beitritt und
/// auf Anweisung des Mikrofon-Wächters (`SpracheMikroWache.swift`) —, und wie
/// er darüber berichtet.
///
/// **Der Befund, gegen den das steht** (TestFlight 2.1, Befundakte vom
/// 2026-10-17): im Sprachkanal fiel das Mikrofon aus, und weder Verlassen noch
/// neues Beitreten half — nur das Wegwischen der App. Ein sauberer Neubeitritt
/// setzt die Kette nur zurück, wenn die Buchführung von SDK und Audio-Maschine
/// beim Verlassen auf „nichts aktiv" kam. Dreierlei überdauert den Raum aber
/// prozessweit: `anrufPausiert`, die Verfügbarkeit der Maschine samt Automatik
/// (K3), und eine hängengebliebene Anforderung im SDK-Beobachter, nach einem
/// gescheiterten `setActive` zurückgerollt (K2). Der nächste Beitritt sah dann
/// keinen Übergang und aktivierte die Session nie.
extension SpracheRaum {
    /// Wie der Raum aufnimmt und sendet — vom Web je Beitritt mitgeschickt.
    struct TonOptionen {
        /// „Volle Tonqualität": WebRTCs eigene Echo-, Pegel- und
        /// Rauschverarbeitung statt Apples Voice-Processing, das am
        /// eingebauten Mikrofon „dumpf wie am Telefon" klang (Befund B in der
        /// Akte vom 2026-10-17). **Ein Vergleichsschalter, Vorgabe AUS** —
        /// WebRTCs Echo-Unterdrückung am iPhone-Lautsprecher ist schwächer als
        /// Apples; ob sie trägt, entscheidet die Echo-Probe am Gerät.
        var volle = false
        /// Sende-Bitrate in kbps (der Server-Wert, wie am Desktop). Nur mit
        /// `volle`; sonst bleibt die Vorgabe des SDK (48 kbps).
        var bitrateKbps: Int?
    }

    /// `adaptiveStream` und `dynacast` sind AN — wie im Web-Weg
    /// (`livekit.svelte.ts::#roomOptions`). Ohne sie empfing das Telefon jede
    /// fremde Kamera in voller Stufe, auch ungesehen, und sendete selbst alle
    /// Simulcast-Ebenen (Akku-Befund 3). **Was „sichtbar" heisst, am SDK 2.17
    /// gelesen:** eine `VideoView` zählt, sobald sie ausgelegt, nicht versteckt
    /// und eingeschaltet ist (`VideoView.isAdaptiveStreamEnabled`), ein
    /// Fenster fragt das SDK nicht ab. Kacheln der Ansicht und das
    /// Bild-in-Bild-Fenster (`SpracheBildImBildInhalt`, eine `SwiftUIVideoView`)
    /// melden sich also richtig an; ohne jede Ansicht pausiert das Video, und
    /// beim Öffnen kommt es nach einem Takt des SDK und einem Vollbild zurück.
    static func raumOptionen(_ ton: TonOptionen) -> RoomOptions {
        guard ton.volle else {
            return RoomOptions(adaptiveStream: true, dynacast: true)
        }
        let aufnahme = AudioCaptureOptions(
            echoCancellationMode: .software, autoGainControlMode: .software,
            noiseSuppressionMode: .software)
        let kbps = ton.bitrateKbps.map { min(510, max(16, $0)) }
        let senden = AudioPublishOptions(encoding: kbps.map { AudioEncoding(maxBitrate: $0 * 1000) })
        return RoomOptions(defaultAudioCaptureOptions: aufnahme, defaultAudioPublishOptions: senden,
                           adaptiveStream: true, dynacast: true)
    }

    // MARK: - Herstellen

    /// Vor jedem Beitritt (nach dem Verlassen, vor dem Verbinden): den
    /// prozessweiten Zustand vollständig neu herstellen — **nur, wenn kein
    /// Anruf der App läuft**. Läuft einer, gehört die Session ihm, und alles
    /// hier bliebe ihm fremd.
    func sitzungFrischHerstellen() async {
        let lage = await MainActor.run { () -> (frei: Bool, haengt: Bool) in
            let v = Anrufverwaltung.geteilt
            let anrufRaum = AnrufRaum.geteilt.raum != nil
            let fremd = CXCallObserver().calls.contains { !$0.hasEnded }
            // CallKit „führt", aber es gibt weder Eintrag noch Raum noch ein
            // Gespräch: die Rückgabe ist ausgeblieben (K3).
            let haengt = v.callkitAktiv && v.kennungen.isEmpty && !v.ohneCallKit
                && !anrufRaum && !fremd
            return (!v.callkitAktiv && !v.ohneCallKit && !anrufRaum, haengt)
        }
        if lage.haengt {
            diagMelden("callkit_haengt", [:])
            await MainActor.run { Anrufverwaltung.geteilt.sessionZurueckgeben() }
        } else if !lage.frei {
            diagMelden("beitritt_neben_anruf", [:])
            return
        }
        if anrufPausiert {
            diagMelden("anruf_pause_haengt", [:])
            anrufPausiert = false
        }
        await maschineNeu(grund: "beitritt")
    }

    /// Den Übergabeweg fahren, den die Hülle für CallKit schon kennt
    /// (`AnrufSitzung.swift`): Automatik aus, Maschine `.none` — die
    /// Audio-Maschine gibt frei, der SDK-Beobachter verbucht das, OHNE die
    /// Session anzufassen, also ohne Rückroll-Gefahr —, Automatik an, Maschine
    /// `.default`. Danach startet die Kette wieder bei „nichts aktiv", und die
    /// nächste Anforderung aktiviert die Session sicher.
    ///
    /// Auf dem Hauptthread, wie die CallKit-Übergabe, und dort noch einmal
    /// gefragt, ob nicht inzwischen ein Anruf die Session übernommen hat.
    func maschineNeu(grund: String) async {
        let fehler = await MainActor.run { () -> String? in
            let v = Anrufverwaltung.geteilt
            guard !v.callkitAktiv, !v.ohneCallKit else { return "anruf" }
            let am = AudioManager.shared
            var fehler: String?
            am.audioSession.isAutomaticConfigurationEnabled = false
            do { try am.setEngineAvailability(.none) } catch { fehler = "none: \(error)" }
            am.audioSession.isAutomaticConfigurationEnabled = true
            do {
                try am.setEngineAvailability(.default)
            } catch {
                // Ohne Mikrofon-Erlaubnis wirft `.default` — dann wenigstens
                // hören (Doc-Kommentar des SDK an `setEngineAvailability`).
                fehler = "default: \(error)"
                try? am.setEngineAvailability(
                    AudioEngineAvailability(isInputAvailable: false, isOutputAvailable: true))
            }
            return fehler
        }
        diagMelden(fehler == nil ? "maschine_neu" : "maschine_neu_fehler",
                   ["grund": grund, "fehler": fehler ?? ""])
    }

    /// Stufe 3 des Wächters: die Mikrofonspur zurücknehmen und neu
    /// veröffentlichen, danach den Stumm-Wunsch wieder anwenden. In der Kette,
    /// damit kein Mikrofon-Befehl dazwischenfährt.
    func mikrofonspurNeu() async {
        do {
            try await nacheinander { [self] in
                guard let r = raum, !anrufPausiert else { return }
                if let pub = r.localParticipant.audioTracks
                    .first(where: { $0.source == .microphone }) as? LocalTrackPublication {
                    try await r.localParticipant.unpublish(publication: pub)
                }
                try await r.localParticipant.setMicrophone(enabled: true)
                if !mikroWunsch { try await Self.stummSchalten(true, in: r) }
                schickeEigenen()
                schickeTeilnehmer()
            }
            diagMelden("spur_neu", [:])
        } catch {
            diagMelden("spur_neu_fehler", ["fehler": error.localizedDescription])
        }
    }

    // MARK: - Berichten

    /// Ein Ereignis des Wächters ans Web — **ohne** die Live Activity
    /// anzustossen (`melden` tut das bei jedem Ereignis).
    func wacheMelden(_ name: String, _ nutzlast: [String: Any]) {
        melde?(name, nutzlast)
    }

    /// Eine Diagnose-Zeile: ins Gerätelog und als `diagnose` ans Web, das sie
    /// in seinen Ringpuffer schreibt (`diagnose/iosTonDiagnose.ts`). **Nie
    /// Kennungen, Namen, Tokens** — nur Zustände.
    func diagMelden(_ art: String, _ extra: [String: Any]) {
        let felder = diagnoseFelder().merging(extra) { $1 }
        NSLog("[PulseSprache] diag %@ %@", art,
              felder.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " "))
        melde?("diagnose", ["art": art, "felder": felder])
    }

    /// Die Zustände, die die drei Ketten der Befundakte unterscheiden.
    func diagnoseFelder() -> [String: Any] {
        let s = AVAudioSession.sharedInstance()
        let am = AudioManager.shared
        let maschine = am.engineAvailability
        return [
            "kat": s.category.rawValue,
            "modus": s.mode.rawValue,
            "opt": optionenNamen().joined(separator: ","),
            "eingangDa": s.isInputAvailable,
            "eingaenge": s.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ","),
            "route": routeJetzt(),
            "fremdTon": s.isOtherAudioPlaying,
            "stilleHinweis": s.secondaryAudioShouldBeSilencedHint,
            "engineLaeuft": am.isEngineRunning,
            "maschineEin": maschine.isInputAvailable,
            "maschineAus": maschine.isOutputAvailable,
            "automatik": am.audioSession.isAutomaticConfigurationEnabled,
            "micMuted": am.isMicrophoneMuted,
            "anrufPausiert": anrufPausiert,
            "callkitAktiv": Anrufverwaltung.geteilt.callkitAktiv,
            "verbunden": raum?.connectionState == .connected,
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "wacheTot": wache.tot
        ]
    }
}
