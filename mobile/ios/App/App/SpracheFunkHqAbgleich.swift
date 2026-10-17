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
    /// Soll der Kanal auf den HQ-Weg (Software-Verarbeitung + Option)?
    /// `bisher`: steht er schon dort — bei unbekannter Fähigkeit bleibt es so.
    static func ziel(wunsch: Bool, lage: FunkLage, gescheitert: Bool, bisher: Bool) -> Bool {
        guard wunsch, lage.ios26, lage.ausgangFunk, !gescheitert else { return false }
        return lage.hqKann ?? bisher
    }

    /// HQ wurde angefordert und gesetzt, das Bluetooth-Mikrofon läuft trotzdem
    /// nicht darin: der Kopfhörer meldet es, trägt es aber nicht.
    static func gescheitert(lage: FunkLage, aufHq: Bool) -> Bool {
        aufHq && lage.optionDa && lage.eingangFunk && !lage.hqAn
    }
}

extension SpracheRaum {
    /// Vor dem Bauen des Raums: startet er gleich auf dem HQ-Weg? Bekannt ist
    /// das nur, wenn die Session schon Eingänge führt (etwa nach einem
    /// Kanalwechsel); sonst startet er mit VPIO und der Abgleich nach dem
    /// Beitritt schaltet um.
    func funkHqVorBeitritt(_ ton: TonOptionen) -> Bool {
        let f = SpracheFunkHq.geteilt
        f.raumWeg()
        let start = FunkHqRegeln.ziel(wunsch: f.wunsch, lage: .lesen(), gescheitert: false, bisher: false)
        f.optionGewollt = f.wunsch && (start || ton.volle)
        return start
    }

    /// Von aussen (Routenwechsel, Schalter) — in die Befehlskette, weil
    /// `setAudioProcessingOptions` blockiert und kein Mikrofon-Befehl
    /// dazwischenfahren soll.
    func funkHqAnstossen(_ grund: String) {
        guard raum != nil else { return }
        einreihen({ [self] in await funkHqAbgleichen(grund) }, fertig: { _ in })
    }

    /// Verarbeitung und Option an die Route anpassen. **Nur in der Kette.**
    ///
    /// Die Wahrheit über die Verarbeitung ist die zuletzt ANGEFORDERTE des
    /// SDK (`audioProcessingState`, prozessweit), kein eigener Merker: ein
    /// Anruf startet seine Spur mit `.automatic`, ein Neuveröffentlichen der
    /// Spur (Wächter, Stufe 3) mit den Vorgaben des Raums — beides stellte
    /// einen Merker still auf falsch.
    func funkHqAbgleichen(_ grund: String) async {
        let f = SpracheFunkHq.geteilt
        guard let r = raum, !anrufPausiert else {
            f.optionGewollt = false
            return
        }
        let frei = await MainActor.run {
            !Anrufverwaltung.geteilt.callkitAktiv && !Anrufverwaltung.geteilt.ohneCallKit
                && AnrufRaum.geteilt.raum == nil
        }
        guard frei, AudioManager.shared.audioSession.isAutomaticConfigurationEnabled else { return }
        let istSoftware = AudioManager.shared.audioProcessingState
            .echoCancellation.requested?.mode == .software
        var lage = FunkLage.lesen()
        let aufHq = istSoftware && !ton.volle
        if !f.gescheitert, FunkHqRegeln.gescheitert(lage: lage, aufHq: aufHq) {
            f.gescheitert = true
            diagMelden("funk_hq_gescheitert", ["grund": grund])
        }
        let ziel = FunkHqRegeln.ziel(wunsch: f.wunsch, lage: lage, gescheitert: f.gescheitert, bisher: aufHq)
        let soll = ziel || ton.volle
        if soll != istSoftware, let spur = r.localParticipant.audioTracks
            .first(where: { $0.source == .microphone })?.track as? LocalAudioTrack {
            do {
                try spur.setAudioProcessingOptions(soll ? Self.volleVerarbeitung : AudioProcessingOptions())
            } catch {
                diagMelden("funk_hq_verarbeitung_fehler", ["fehler": error.localizedDescription])
            }
        }
        f.optionGewollt = f.wunsch && soll
        SpracheFunkHq.optionDurchsetzen(grund)
        lage = FunkLage.lesen()
        let kurz = "\(lage.art)/\(ziel ? "ziel-hq" : "ziel-apple")"
        if kurz != f.letzteArt {
            f.letzteArt = kurz
            diagMelden("funk_route", ["grund": grund, "ziel": ziel ? "hq" : "apple"])
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
            "hqOpt": l.optionDa,
            "hqKann": l.hqKann.map { $0 ? "ja" : "nein" } ?? "unbekannt",
            "hqAn": l.hqAn,
            "rate": Int(s.sampleRate),
            "eingKanaele": s.inputNumberOfChannels,
            "ausKanaele": s.outputNumberOfChannels
        ]
    }
}
