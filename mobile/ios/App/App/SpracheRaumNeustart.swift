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
        ///
        /// **Seit dem 2026-10-17 unerreichbar** (Eigentümer-Entscheid): die
        /// Oberfläche bietet den Schalter nicht an und schickt immer `false`
        /// (`web/src/lib/platform/iosVolleTon.ts`); es gilt Apples VPIO. Der
        /// Weg hier bleibt bestehen, damit ein Wiederanbieten nur die Web-Seite
        /// braucht.
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
        let senden = AudioPublishOptions(
            encoding: kbpsBegrenzt(ton).map { AudioEncoding(maxBitrate: $0 * 1000) })
        return RoomOptions(defaultAudioCaptureOptions: aufnahme, defaultAudioPublishOptions: senden,
                           adaptiveStream: true, dynacast: true)
    }

    /// Die Server-Bitrate, auf das begrenzt, was Opus trägt.
    static func kbpsBegrenzt(_ ton: TonOptionen) -> Int? {
        ton.bitrateKbps.map { min(510, max(16, $0)) }
    }

    /// Dieselbe Verarbeitung wie `raumOptionen` bei `volle`, als
    /// Laufzeit-Optionen einer Spur.
    static let volleVerarbeitung = AudioProcessingOptions(
        echoCancellationMode: .software, autoGainControlMode: .software,
        noiseSuppressionMode: .software)

    /// **Nach einem Direktanruf „Volle Tonqualität" wiederherstellen** (L2 der
    /// Prüfung vom 2026-10-17). Die Spur des Anrufs startet ihre Aufnahme mit
    /// `.automatic` — die Audio-Maschine ist prozessweit EINE, also läuft
    /// danach auch der Kanal über Apples Voice-Processing und die Session im
    /// Modus `.voiceChat`/`.videoChat`. Ein Aufheben der Stummschaltung startet
    /// keine Aufnahme neu (SDK 2.17 `Track._unmute`), stellt also nichts zurück.
    ///
    /// **Was `setAudioProcessingOptions` nachzieht, am SDK 2.17 gelesen:** die
    /// Optionen gehen über den Sender an die Audio-Maschine, ohne die Aufnahme
    /// neu zu starten (`LocalAudioTrack.swift`, Doc-Kommentar — der C++-Teil
    /// liegt nicht im Quelltext vor), und danach
    /// `updateExpectedPlatformVoiceProcessing` → `isPlatformVoiceProcessingExpected
    /// = false` → `onDidMutate` → `configureAudioSession` → Modus `.default`
    /// (`AudioSessionEngineObserver.swift`), sofern die automatische
    /// Konfiguration an ist — `sessionZurueckgeben` schaltet sie vor dem Ende
    /// der Pause wieder ein. Ob VPIO wirklich aus ist, sagt die Diagnose-Zeile
    /// (`vpio`).
    func volleTonZurueck(in r: Room) {
        guard let spur = r.localParticipant.audioTracks
            .first(where: { $0.source == .microphone })?.track as? LocalAudioTrack
        else { return }
        do {
            let ergebnis = try spur.setAudioProcessingOptions(Self.volleVerarbeitung)
            diagMelden("volle_ton_zurueck", ["ergebnis": "\(ergebnis)"])
        } catch {
            diagMelden("volle_ton_zurueck_fehler", ["fehler": error.localizedDescription])
        }
    }

    // MARK: - Herstellen

    /// Vor jedem Beitritt (nach dem Verlassen, vor dem Verbinden): den
    /// prozessweiten Zustand vollständig neu herstellen — **nur, wenn kein
    /// Anruf der App läuft**. Läuft einer, gehört die Session ihm, und alles
    /// hier bliebe ihm fremd.
    /// `true`, wenn die Maschine neu angestossen wurde — dann hält der
    /// Stream-Ton seine Session-Anforderung zurück, bis der Beitritt steht, und
    /// der Rufer gibt sie mit `StreamTonSitzung.automatikAn` frei (S3).
    @discardableResult
    func sitzungFrischHerstellen() async -> Bool {
        await rueckgabeAbwarten()
        let lage = await MainActor.run { () -> (frei: Bool, haengt: Bool) in
            let v = Anrufverwaltung.geteilt
            let anrufRaum = AnrufRaum.geteilt.raum != nil
            let fremd = CXCallObserver().calls.contains { !$0.hasEnded }
            // CallKit „führt", aber es gibt weder Eintrag noch Raum noch ein
            // Gespräch, die Session ist nicht mehr aktiv, und keine Rückgabe
            // steht aus: die Rückgabe ist ausgeblieben (K3).
            let haengt = v.callkitAktiv && v.kennungen.isEmpty && !v.ohneCallKit
                && !anrufRaum && !fremd && !v.sessionAktiv && v.rueckgabeUhr == nil
            return (!v.callkitAktiv && !v.ohneCallKit && !anrufRaum, haengt)
        }
        if lage.haengt {
            diagMelden("callkit_haengt", [:])
            await MainActor.run { Anrufverwaltung.geteilt.sessionZurueckgeben() }
        } else if !lage.frei {
            diagMelden("beitritt_neben_anruf", [:])
            return false
        }
        if anrufPausiert {
            diagMelden("anruf_pause_haengt", [:])
            anrufPausiert = false
        }
        await maschineNeu(grund: "beitritt", streamTonZurueck: false)
        return true
    }

    /// **Nach dem Auflegen gibt CallKit die Session erst mit `didDeactivate`
    /// zurück** — bis zu 3 s (`letzterAnrufVorbei`). Ein Beitritt in diesem
    /// Fenster wartet darauf, statt vorzeitig zurückzugeben: sonst richtete das
    /// SDK die Session ein, und CallKit deaktivierte sie Augenblicke später
    /// unter dem neuen Kanal weg (Kopf von `AnrufSitzung.swift`, Gegenprüfung T2).
    private func rueckgabeAbwarten() async {
        for _ in 0 ..< 40 {
            let wartet = await MainActor.run { () -> Bool in
                let v = Anrufverwaltung.geteilt
                return v.callkitAktiv && v.kennungen.isEmpty && !v.ohneCallKit
                    && (v.sessionAktiv || v.rueckgabeUhr != nil)
            }
            guard wartet else { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
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
    ///
    /// **Scheitert das Freigeben, steht die Maschine auf `.none`** — ein
    /// Zurück auf den Stand davor gibt es nicht, der wäre derselbe Versuch
    /// (Gegenprüfung 2, U5). Der Wächter liest den wahren Stand und holt das
    /// Freigeben nach, sobald es erlaubt ist (`SpracheMikroWache`). „Nur
    /// Ausgabe" gibt es allein bei fehlender Mikrofon-Erlaubnis — sonst wäre
    /// ein vorübergehender Fehlschlag ein dauerhaft taubes Mikrofon.
    ///
    /// `streamTonZurueck: false` (nur beim Beitritt, Gegenprüfung S3): der
    /// Stream-Ton holt seine Anforderung NICHT gleich zurück. Sonst machte
    /// ER den Übergang „nichts aktiv → aktiv" (mit `.playback`), und der Kanal
    /// stellte danach nur noch die Kategorie um — ein anderer Weg als der, mit
    /// dem der Mikrofon-Befund geheilt und am Gerät geprüft wurde. So aktiviert
    /// die Maschine des Kanals wie ohne Stream; die Session bleibt solange
    /// aktiv, weil das Loslassen ohne Automatik nichts deaktiviert.
    func maschineNeu(grund: String, streamTonZurueck: Bool = true) async {
        let fehler = await MainActor.run { () -> String? in
            let v = Anrufverwaltung.geteilt
            guard !v.callkitAktiv, !v.ohneCallKit else { return nil }
            let am = AudioManager.shared
            am.audioSession.isAutomaticConfigurationEnabled = false
            // Der native Stream-Ton lässt seine Session-Anforderung los, solange
            // die Automatik aus ist — sonst sähe LiveKit gleich keinen Übergang
            // „nichts aktiv → aktiv" und aktivierte nicht (`StreamTonSitzung`).
            StreamTonSitzung.geteilt.automatikAus()
            try? am.setEngineAvailability(.none)
            am.audioSession.isAutomaticConfigurationEnabled = true
            let fehler = Self.maschineFreigebenJetzt()
            if streamTonZurueck { StreamTonSitzung.geteilt.automatikAn(grund: "maschine_neu") }
            return fehler
        }
        diagMelden(fehler == nil ? "maschine_neu" : "maschine_neu_fehler",
                   ["grund": grund, "fehler": fehler ?? ""])
    }

    /// Nachholen, wenn der Wächter die Maschine gesperrt vorfindet. `true` =
    /// frei. `melden`: einen Fehlschlag als Diagnose-Zeile — der Wächter
    /// meldet nur den ersten, sonst verdrängten die Wiederholungen die
    /// Ursache aus dem gekappten Bericht.
    func maschineFreigeben(melden: Bool) async -> Bool {
        let fehler = await MainActor.run { () -> String? in
            let v = Anrufverwaltung.geteilt
            guard !v.callkitAktiv, !v.ohneCallKit else { return nil }
            AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = true
            let fehler = Self.maschineFreigebenJetzt()
            StreamTonSitzung.geteilt.automatikAn(grund: "nachholen")
            return fehler
        }
        if fehler == nil || melden {
            diagMelden(fehler == nil ? "maschine_frei" : "maschine_neu_fehler",
                       ["grund": "nachholen", "fehler": fehler ?? ""])
        }
        return fehler == nil
    }

    /// `.default`; ohne Mikrofon-Erlaubnis nur die Ausgabe (sonst wirft das
    /// SDK `deviceAccessDenied` und man hörte nicht einmal). `nil` = frei.
    @MainActor private static func maschineFreigebenJetzt() -> String? {
        let ziel = Anrufverwaltung.mikrofonErlaubt()
            ? AudioEngineAvailability.default
            : AudioEngineAvailability(isInputAvailable: false, isOutputAvailable: true)
        do {
            try AudioManager.shared.setEngineAvailability(ziel)
            return nil
        } catch {
            return "\(error)"
        }
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

    /// Was beim Beitritt WIRKLICH gilt, nicht nur der Wunsch `volleTon` (L3
    /// der Prüfung vom 2026-10-17): Echo-Unterdrückung, wie die geteilte
    /// Verarbeitung sie aufgelöst hat, und die Sende-Obergrenze in kbps (48 =
    /// die SDK-Vorgabe `presetMusic`). `vpio` steht in `diagnoseFelder`.
    ///
    /// **Faden:** `audioProcessingState` ist ein öffentlicher, synchroner
    /// Getter, der in WebRTCs Fabrik blockierend liest — wie die ADM-Getter in
    /// `diagnoseFelder`. Gerufen wird er nur aus der Befehlskette, nie von
    /// einem WebRTC-Faden.
    func tonBeleg(_ ton: TonOptionen) -> [String: Any] {
        let vorgabe = AudioEncoding.presetMusic.maxBitrate / 1000
        return [
            "aec": AudioManager.shared.audioProcessingState.echoCancellation.effective.description,
            "kbps": ton.volle ? (Self.kbpsBegrenzt(ton) ?? vorgabe) : vorgabe
        ]
    }

    /// Die Zustände, die die drei Ketten der Befundakte unterscheiden. `vpio`:
    /// läuft Apples Voice-Processing gerade (Live-Wert vom Eingangsknoten,
    /// `false` vor dem Einrichten der Aufnahme) — deckt auch auf, wenn ein
    /// Anruf es unter „Volle Tonqualität" wieder eingeschaltet hat.
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
            "vpio": am.platformVoiceProcessingState.voiceProcessingEnabled.isActive,
            "anrufPausiert": anrufPausiert,
            "callkitAktiv": Anrufverwaltung.geteilt.callkitAktiv,
            "verbunden": raum?.connectionState == .connected,
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "wacheTot": wache.tot
        ]
    }
}
