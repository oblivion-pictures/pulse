import AVFoundation
import LiveKit

/// Was die Route über Bluetooth gerade hergibt — gelesen, nicht angenommen.
struct FunkLage {
    var ios26 = false
    /// Geht die Ausgabe an einen Bluetooth-Kopfhörer?
    var ausgangFunk = false
    /// Nimmt ein Bluetooth-Mikrofon auf?
    var eingangFunk = false
    /// Kann ein Bluetooth-Mikrofon der Route HQ? `nil`: keines sichtbar (die
    /// Session führt Eingänge nur unter `.playAndRecord`).
    var hqKann: Bool?
    /// Läuft HQ am aktuellen Eingang?
    var hqAn = false
    var optionDa = false
    /// Für die Diagnose: `hq`, `hfp`, `le`, `a2dp` oder `-` (kein Bluetooth).
    var art = "-"

    static func lesen() -> FunkLage {
        let s = AVAudioSession.sharedInstance()
        let route = s.currentRoute
        let funk: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothLE, .bluetoothA2DP]
        var l = FunkLage()
        l.ausgangFunk = route.outputs.contains { funk.contains($0.portType) }
        l.eingangFunk = route.inputs.contains { funk.contains($0.portType) }
        if #available(iOS 26.0, *) {
            l.ios26 = true
            l.optionDa = s.categoryOptions.contains(.bluetoothHighQualityRecording)
            let kandidaten = route.inputs + (s.availableInputs ?? [])
            let mikros = kandidaten.compactMap(\.bluetoothMicrophoneExtension)
            if !mikros.isEmpty {
                l.hqKann = mikros.contains { $0.highQualityRecording.isSupported }
            } else if kandidaten.contains(where: { funk.contains($0.portType) }) {
                l.hqKann = false
            }
            l.hqAn = route.inputs.contains {
                $0.bluetoothMicrophoneExtension?.highQualityRecording.isEnabled == true
            }
            l.eingangFunk = l.eingangFunk || route.inputs.contains { $0.bluetoothMicrophoneExtension != nil }
        }
        l.art = routenArt(ausgaenge: Set(route.outputs.map(\.portType)), hqAn: l.hqAn)
        return l
    }

    private static func routenArt(ausgaenge: Set<AVAudioSession.Port>, hqAn: Bool) -> String {
        if hqAn { return "hq" }
        if ausgaenge.contains(.bluetoothHFP) { return "hfp" }
        if ausgaenge.contains(.bluetoothLE) { return "le" }
        if ausgaenge.contains(.bluetoothA2DP) { return "a2dp" }
        return "-"
    }
}

/// Die Entscheidung, ohne Seiteneffekt.
enum FunkHqRegeln {
    /// Soll der Kanal auf dem HQ-Weg stehen? `haelt`: steht er schon dort —
    /// dann bleibt er, bis der Kopfhörer weg ist (ein Zwischenstand der Route
    /// während des eigenen Umschaltens soll ihn nicht zurückwerfen).
    static func ziel(wunsch: Bool, lage: FunkLage, gescheitert: Bool, haelt: Bool) -> Bool {
        guard wunsch, lage.ios26, lage.ausgangFunk, !gescheitert else { return false }
        return haelt || lage.hqKann == true
    }

    /// Wir halten die Session mit HQ, das Bluetooth-Mikrofon läuft trotzdem
    /// nicht darin: der Kopfhörer meldet es, trägt es aber nicht.
    static func gescheitert(lage: FunkLage, haelt: Bool) -> Bool {
        haelt && lage.eingangFunk && !lage.hqAn
    }
}

extension SpracheRaum {
    /// Von aussen (Routenwechsel, Schalter) — in die Befehlskette, weil
    /// `setAudioProcessingOptions` blockiert und kein Mikrofon-Befehl
    /// dazwischenfahren soll.
    func funkHqAnstossen(_ grund: String) {
        guard raum != nil else { return }
        einreihen({ [self] in await funkHqAbgleichen(grund) }, fertig: { _ in })
    }

    /// Verarbeitung und Session an die Route anpassen. **Nur in der Kette.**
    ///
    /// Die Wahrheit über die Verarbeitung ist die zuletzt ANGEFORDERTE des
    /// SDK (`audioProcessingState`, prozessweit), kein eigener Merker: ein
    /// Anruf startet seine Spur mit `.automatic`, ein Neuveröffentlichen der
    /// Spur (Wächter, Stufe 3) mit den Vorgaben des Raums.
    func funkHqAbgleichen(_ grund: String) async {
        let f = SpracheFunkHq.geteilt
        guard let r = raum, !anrufPausiert else { return }
        let frei = await MainActor.run {
            !Anrufverwaltung.geteilt.callkitAktiv && !Anrufverwaltung.geteilt.ohneCallKit
                && AnrufRaum.geteilt.raum == nil
        }
        guard frei else { return }
        var haelt = f.haelt
        let automatik = AudioManager.shared.audioSession.isAutomaticConfigurationEnabled
        if haelt, automatik {
            // Ein Heilweg (`maschineNeu`) hat sie zurückgestellt; das SDK hat
            // seither wieder eingerichtet.
            f.verloren()
            haelt = false
            diagMelden("funk_hq_verloren", ["grund": grund])
        }
        if !haelt, !automatik { return }   // jemand anderes hält sie gerade
        let lage = FunkLage.lesen()
        // **Nur im eigenen, verzögerten Abgleich** (Gegenprüfung B1): jedes
        // Umschalten löst selbst Routenwechsel aus, und der Abgleich, den sie
        // einreihen, läuft Millisekunden später — dann ist der Kopfhörer
        // vermutlich noch mitten im Wechsel HFP → HQ, und `isEnabled` stünde
        // fälschlich auf false.
        if grund == Self.funkPruefGrund, !f.gescheitert,
           FunkHqRegeln.gescheitert(lage: lage, haelt: haelt) {
            f.gescheitert = true
            diagMelden("funk_hq_gescheitert", ["grund": grund])
        }
        var ziel = FunkHqRegeln.ziel(wunsch: f.wunsch, lage: lage, gescheitert: f.gescheitert, haelt: haelt)
        if ziel, !haelt, f.uebernahmeZaehlen() {
            f.gescheitert = true
            ziel = false
            diagMelden("funk_hq_pendelt", ["grund": grund])
        }
        let spur = r.localParticipant.audioTracks
            .first(where: { $0.source == .microphone })?.track as? LocalAudioTrack
        let istSoftware = AudioManager.shared.audioProcessingState
            .echoCancellation.requested?.mode == .software
        if ziel {
            await funkHqHalten(spur, schonGehalten: haelt, optionDa: lage.optionDa,
                               istSoftware: istSoftware, grund: grund)
        } else {
            // Zurück auf VPIO am Lautsprecher: bis es läuft, nichts hören
            // lassen (B3; `kopfhoererWeg` tut dasselbe schon im Beobachter).
            if istSoftware, !ton.volle, !lage.ausgangFunk { f.daempfen() }
            await funkHqZurueck(spur, hielt: f.loslassen(), istSoftware: istSoftware,
                                optionDa: lage.optionDa, grund: grund)
        }
        let neu = FunkLage.lesen()
        let kurz = "\(neu.art)/\(f.haelt ? "hq" : "apple")"
        if kurz != f.letzteArt {
            f.letzteArt = kurz
            diagMelden("funk_route", ["grund": grund, "ziel": ziel ? "hq" : "apple"])
        }
    }

    /// Übernehmen (oder nach einem Neuveröffentlichen der Spur nachziehen):
    /// erst die Automatik nehmen, DANN die Verarbeitung wechseln — sonst
    /// richtete das SDK dazwischen noch einmal seine eigene Kategorie ein.
    private func funkHqHalten(_ spur: LocalAudioTrack?, schonGehalten: Bool, optionDa: Bool,
                              istSoftware: Bool, grund: String) async {
        let f = SpracheFunkHq.geteilt
        if !schonGehalten {
            guard await MainActor.run(body: { f.automatikNehmen() }) else { return }
        }
        if !istSoftware { verarbeitungSetzen(spur, software: true) }
        guard !schonGehalten || !optionDa else { return }
        if let fehler = await MainActor.run(body: { f.hqEinrichten() }) {
            f.gescheitert = true
            diagMelden("funk_hq_fehler", ["grund": grund, "fehler": fehler])
            await funkHqZurueck(spur, hielt: f.loslassen(), istSoftware: true, optionDa: true,
                                grund: "fehler")
            return
        }
        diagMelden("funk_hq_an", ["grund": grund])
        let gemeint = sitzung
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.funkPruefFrist) { [weak self] in
            guard let self, sitzung == gemeint else { return }
            funkHqAnstossen(Self.funkPruefGrund)
        }
    }

    /// Wie lange der Kopfhörer für den Wechsel auf HQ Zeit bekommt, bevor
    /// „springt nicht an" gilt. Geschätzt, nicht gemessen — der Abstand
    /// `funk_hq_an` → `funk_hq_gescheitert` im Bericht zeigt, ob er reicht.
    static let funkPruefFrist: TimeInterval = 3
    static let funkPruefGrund = "hq_pruefen"

    /// Zurück an das SDK. Wechselt die Verarbeitung zurück auf `.automatic`,
    /// richtet das SDK seine Kategorie dabei selbst neu ein
    /// (`isPlatformVoiceProcessingExpected` → `onDidMutate`); sonst setzen
    /// wir sie so, wie es das SDK täte, damit die HQ-Option nicht stehen bleibt.
    private func funkHqZurueck(_ spur: LocalAudioTrack?, hielt: Bool, istSoftware: Bool,
                               optionDa: Bool, grund: String) async {
        if istSoftware, !ton.volle {
            verarbeitungSetzen(spur, software: false)
        } else if optionDa {
            await MainActor.run { SpracheFunkHq.geteilt.sdkKategorieSetzen(software: istSoftware) }
        }
        if hielt { diagMelden("funk_hq_aus", ["grund": grund]) }
    }

    private func verarbeitungSetzen(_ spur: LocalAudioTrack?, software: Bool) {
        guard let spur else { return }
        do {
            try spur.setAudioProcessingOptions(software ? Self.volleVerarbeitung : AudioProcessingOptions())
        } catch {
            diagMelden("funk_hq_verarbeitung_fehler", ["fehler": error.localizedDescription])
        }
    }

    /// Für jede Diagnose-Zeile: welcher Bluetooth-Weg lief wirklich. Nur
    /// Zustände — keine Gerätenamen (die Zeile geht in den Bericht).
    func funkFelder() -> [String: Any] {
        let s = AVAudioSession.sharedInstance()
        let l = FunkLage.lesen()
        // `ProcessInfo` statt `UIDevice`: gerufen auch vom Faden des
        // Routen-Beobachters, und `UIDevice` gehört dem Hauptthread.
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return [
            "ios": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
            "funkArt": l.art,
            "funkWunsch": SpracheFunkHq.geteilt.wunsch,
            "funkHaelt": SpracheFunkHq.geteilt.haelt,
            "hqOpt": l.optionDa,
            "hqKann": l.hqKann.map { $0 ? "ja" : "nein" } ?? "unbekannt",
            "hqAn": l.hqAn,
            "rate": Int(s.sampleRate),
            "eingKanaele": s.inputNumberOfChannels,
            "ausKanaele": s.outputNumberOfChannels
        ]
    }
}
