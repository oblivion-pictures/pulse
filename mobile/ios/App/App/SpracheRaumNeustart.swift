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
    static func raumOptionen() -> RoomOptions {
        RoomOptions(defaultAudioCaptureOptions: aufnahmeOptionen,
                    adaptiveStream: true, dynacast: true)
    }

    /// **Automatische Mikrofon-Regelung (AGC) AUS, Echo- und Rauschunterdrückung
    /// bleiben** (Eigentümer-Entscheid 2026-10-18). Grund: Angleichen an den
    /// Desktop, dort ist AGC bewusst aus (`autoGainControl: false`, Makeup 1);
    /// mit der SDK-Vorgabe (Apples VPIO-AGC an) klangen Nutzer vom iPhone viel
    /// lauter. **Gefolgert, nicht gemessen** — am Gerät mit dem Feld `agc` der
    /// Diagnose zu belegen. Wirkung laut SDK 2.17 (`AudioManager`,
    /// `AudioProcessingOptions`): `isVoiceProcessingAGCEnabled` darf zur
    /// Laufzeit gesetzt werden, aber „Runtime `AudioProcessingOptions` may
    /// overwrite this … when capture starts or when local audio track options
    /// are reapplied" — der Schalter allein genügt also nicht. Darum zweierlei:
    /// (1) die Aufnahme-Optionen des Raums tragen `autoGainControl: false`
    /// (gelten für jede neu veröffentlichte Spur, auch im Anruf), (2) `agcAus()`
    /// setzt den VPIO-Schalter nach jedem Aufbau der Kette noch einmal.
    static let aufnahmeOptionen = AudioCaptureOptions(autoGainControl: false)

    /// Die Verarbeitung der Spur am Lautsprecher/Ohr (Apples VPIO), AGC aus —
    /// Rückweg aus Bluetooth-HQ. Begründung an `aufnahmeOptionen`.
    static let vpioVerarbeitung = AudioProcessingOptions(autoGainControl: false)

    /// Der VPIO-Schalter, einzige Stelle: nach Beitritt, Spur-Neubau, Neubau der
    /// Maschine (Heilwege, Rückgabe aus Anruf/Bluetooth-HQ) und im Anruf zu
    /// rufen. Synchroner Getter/Setter in WebRTCs Fabrik — nie von einem
    /// WebRTC-Faden aus.
    static func agcAus() {
        AudioManager.shared.isVoiceProcessingAGCEnabled = false
    }

    /// WebRTCs eigene Echo-, Pegel- und Rauschverarbeitung statt Apples
    /// Voice-Processing — nur noch für Bluetooth in hoher Qualität
    /// (`SpracheFunkHqAbgleich`): dort läuft die Aufnahme ohne VPIO, siehe
    /// `SpracheFunkHq.swift`. („Volle Tonqualität" als Schalter gibt es nicht
    /// mehr; Eigentümer-Entscheid 2026-10-17, es gilt Apples VPIO.)
    /// AGC auch hier aus (Begründung an `aufnahmeOptionen`).
    static let softwareVerarbeitung = AudioProcessingOptions(
        echoCancellation: true, autoGainControl: false, noiseSuppression: true,
        echoCancellationMode: .software, noiseSuppressionMode: .software)

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
    /// stellte danach nur noch die Kategorie um. So verbucht LiveKit den
    /// Übergang „nichts → Aufnahme" selbst und richtet PlayAndRecord ein.
    ///
    /// **Was das NICHT ändert, ehrlich:** läuft beim Beitritt eine Kachel, ist
    /// die Session schon aktiv (ihre Maschine spielt; deaktivieren ginge nur mit
    /// einer Pause des Stream-Tons). LiveKits `setActive(true)` trifft dann eine
    /// aktive Session, der Beitritt ist ein Kategoriewechsel `.playback` →
    /// `.playAndRecord` — nicht der Weg, mit dem der Mikrofon-Befund geheilt
    /// wurde. LiveKit kennt denselben Wechsel aus „stumm beitreten, Mikrofon
    /// an". **Am Gerät zu prüfen** (orangener Punkt, Wächter-Puffer, ob fremde
    /// Musik endet). Ohne laufende Kachel hat die Hülle die Session nach dem
    /// letzten Stream-Ton deaktiviert (`StreamTonSitzung.nachDemLetzten`), dort
    /// gilt der geprüfte Weg.
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
        // Der Heilweg hat die Automatik zurückgestellt — hielt der Kanal die
        // Session für Bluetooth-HQ, übernimmt der Abgleich sie neu (B5).
        // Beim Beitritt steht noch kein Raum, dort tut das nichts.
        funkHqAnstossen("maschine_neu")
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
        if fehler == nil { funkHqAnstossen("maschine_frei") }
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
            if ziel.isInputAvailable { agcAus() }
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
                Self.agcAus()
                if !mikroWunsch { try await Self.stummSchalten(true, in: r) }
                schickeEigenen()
                schickeTeilnehmer()
            }
            diagMelden("spur_neu", [:])
            // Die neue Spur kommt mit den Vorgaben des Raums (VPIO) — für
            // Bluetooth-HQ zieht der Abgleich die Verarbeitung nach (B5).
            funkHqAnstossen("spur_neu")
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

    /// Was beim Beitritt WIRKLICH gilt: Echo-Unterdrückung, wie die geteilte
    /// Verarbeitung sie aufgelöst hat, und die Sende-Obergrenze in kbps (48 =
    /// die SDK-Vorgabe `presetMusic`). `vpio` steht in `diagnoseFelder`.
    ///
    /// **Faden:** `audioProcessingState` ist ein öffentlicher, synchroner
    /// Getter, der in WebRTCs Fabrik blockierend liest — wie die ADM-Getter in
    /// `diagnoseFelder`. Gerufen wird er nur aus der Befehlskette, nie von
    /// einem WebRTC-Faden.
    func tonBeleg() -> [String: Any] {
        [
            "aec": AudioManager.shared.audioProcessingState.echoCancellation.effective.description,
            "agcMod": AudioManager.shared.audioProcessingState.autoGainControl.effective.description,
            "kbps": AudioEncoding.presetMusic.maxBitrate / 1000
        ]
    }

    /// Die Zustände, die die drei Ketten der Befundakte unterscheiden. `vpio`:
    /// läuft Apples Voice-Processing gerade (Live-Wert vom Eingangsknoten,
    /// `false` vor dem Einrichten der Aufnahme).
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
            // Apples VPIO-AGC: Live-Wert vom Eingangsknoten (false auch, wo
            // nicht beobachtbar) und der zuletzt angeforderte. Soll: beide false.
            "agc": am.platformVoiceProcessingState.voiceProcessingAGCEnabled.isActive,
            "agcAngef": am.platformVoiceProcessingState.voiceProcessingAGCEnabled.isRequested,
            "anrufPausiert": anrufPausiert,
            "callkitAktiv": Anrufverwaltung.geteilt.callkitAktiv,
            "verbunden": raum?.connectionState == .connected,
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "wacheTot": wache.tot
        ].merging(funkFelder()) { $1 }
    }
}
