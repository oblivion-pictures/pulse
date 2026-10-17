import AVFoundation
import LiveKit

/// Was die Route über Bluetooth gerade hergibt — gelesen, nicht angenommen.
///
/// **Nur die AKTUELLE Route zählt** (Gegenprüfung B4). Die erste Fassung las
/// auch `availableInputs`: verbundene, aber nicht gewählte AirPods machten
/// dann eine Soundbar (nur A2DP, Mikrofon eingebaut) zum HQ-Fall —
/// Software-Echo-Unterdrückung an einem Raumlautsprecher.
struct FunkLage {
    var ios26 = false
    /// Geht die Ausgabe an ein Bluetooth-Gerät (jedes Profil)?
    var ausgangFunk = false
    /// Welches (`uid` des ersten Bluetooth-Ausgangs) — nur zum Vergleich,
    /// nie in der Diagnose.
    var ausgangUid: String?
    /// …an eines mit Sprechprofil (HFP oder LE) — also ein Headset, keine
    /// reine A2DP-Box?
    var ausgangSprech = false
    /// Nimmt ein Bluetooth-Mikrofon auf?
    var eingangFunk = false
    /// Kann das Bluetooth-Mikrofon der Route HQ? `nil`: keines in der Route.
    var hqKann: Bool?
    /// Läuft HQ am aktuellen Eingang?
    var hqAn = false
    var optionDa = false
    /// Für die Diagnose: `hq`, `hfp`, `le`, `a2dp` oder `-` (kein Bluetooth).
    var art = "-"

    static func lesen() -> FunkLage {
        let s = AVAudioSession.sharedInstance()
        let route = s.currentRoute
        // Am Namen statt an einer Liste: unter HQ meldet iOS womöglich einen
        // Porttyp, den es heute nicht gibt — alle Bluetooth-Typen beginnen so.
        let funk = { (p: AVAudioSessionPortDescription) in p.portType.rawValue.hasPrefix("Bluetooth") }
        var l = FunkLage()
        l.ausgangUid = route.outputs.first(where: funk)?.uid
        l.ausgangFunk = l.ausgangUid != nil
        l.ausgangSprech = route.outputs.contains { [.bluetoothHFP, .bluetoothLE].contains($0.portType) }
        l.eingangFunk = route.inputs.contains(where: funk)
        if #available(iOS 26.0, *) {
            l.ios26 = true
            l.optionDa = s.categoryOptions.contains(.bluetoothHighQualityRecording)
            let mikros = route.inputs.compactMap(\.bluetoothMicrophoneExtension)
            l.eingangFunk = l.eingangFunk || !mikros.isEmpty
            if !mikros.isEmpty {
                l.hqKann = mikros.contains { $0.highQualityRecording.isSupported }
            } else if l.eingangFunk {
                l.hqKann = false
            }
            l.hqAn = mikros.contains { $0.highQualityRecording.isEnabled }
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
    /// dann bleibt er, solange `haltenOk` (dasselbe Gerät, s.
    /// `SpracheFunkHq.haltenErlaubt`); ein Zwischenstand der Route während
    /// des eigenen Umschaltens soll ihn nicht zurückwerfen.
    static func ziel(wunsch: Bool, lage: FunkLage, gescheitert: Bool, haelt: Bool,
                     haltenOk: Bool) -> Bool {
        guard wunsch, lage.ios26, lage.ausgangFunk, !gescheitert else { return false }
        if haelt { return haltenOk }
        return lage.ausgangSprech && lage.eingangFunk && lage.hqKann == true
    }

    /// Wir halten die Session mit HQ, und kein Eingang der Route läuft darin —
    /// ob HFP oder das eingebaute Mikrofon aufnimmt: beides ist nicht der
    /// Weg, für den wir Apples Verarbeitung abgegeben haben.
    static func gescheitert(lage: FunkLage, haelt: Bool) -> Bool {
        haelt && !lage.hqAn
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
        //
        // Seit C6 auch nach jedem Routenwechsel, solange wir halten — so fällt
        // auf, wenn HQ später abfällt; gewertet nur bei seither ruhiger Route.
        if f.erholen() { diagMelden("funk_hq_erholt", ["grund": grund]) }
        if grund == Self.funkPruefGrund, !f.gescheitert, f.ruhig(seit: Self.funkPruefFrist),
           FunkHqRegeln.gescheitert(lage: lage, haelt: haelt) {
            funkHqAufgeben("funk_hq_gescheitert", grund)
        } else if grund == Self.funkErholGrund, f.gescheitert {
            funkHqSpaeter(Self.funkErholGrund, nach: 30)
        }
        var ziel = FunkHqRegeln.ziel(wunsch: f.wunsch, lage: lage, gescheitert: f.gescheitert,
                                     haelt: haelt, haltenOk: f.haltenErlaubt(lage))
        if ziel, !haelt, f.uebernahmeZaehlen() {
            ziel = false
            funkHqAufgeben("funk_hq_pendelt", grund)
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
            if istSoftware, !ton.volle, !lage.ausgangSprech || !lage.eingangFunk { f.daempfen() }
            await funkHqZurueck(spur, istSoftware: istSoftware,
                                optionDa: lage.optionDa, grund: grund)
        }
        let neu = FunkLage.lesen()
        let kurz = "\(neu.art)/\(f.haelt ? "hq" : "apple")"
        if f.artGewechselt(kurz) {
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
            // „verloren": dazwischen kam ein Anruf oder der Kopfhörer ging
            // (C4). Kein Fehlschlag des Kopfhörers — nicht für den ganzen Raum
            // aufgeben; das Ende des Anrufs bzw. die nächste Route versucht neu.
            if fehler == SpracheFunkHq.verlorenGrund {
                diagMelden("funk_hq_abgebrochen", ["grund": grund, "fehler": fehler])
            } else {
                funkHqAufgeben("funk_hq_fehler", grund, ["fehler": fehler])
            }
            await funkHqZurueck(spur, istSoftware: true, optionDa: true,
                                grund: "fehler")
            return
        }
        diagMelden("funk_hq_an", ["grund": grund])
        funkHqSpaeter(Self.funkPruefGrund, nach: Self.funkPruefFrist)
    }

    /// Für diesen Raum aufgeben — mit Diagnose-Zeile und dem Termin, an dem
    /// die Erholung nachsieht (C6).
    private func funkHqAufgeben(_ art: String, _ grund: String, _ extra: [String: Any] = [:]) {
        SpracheFunkHq.geteilt.gescheitert = true
        diagMelden(art, extra.merging(["grund": grund]) { $1 })
        funkHqSpaeter(Self.funkErholGrund, nach: SpracheFunkHq.erholungNach)
    }

    /// Einen Abgleich später einreihen — nur für dieselbe Sitzung.
    func funkHqSpaeter(_ grund: String, nach: TimeInterval) {
        let gemeint = sitzung
        DispatchQueue.global().asyncAfter(deadline: .now() + nach) { [weak self] in
            guard let self, sitzung == gemeint else { return }
            funkHqAnstossen(grund)
        }
    }

    /// Aus dem Routen-Beobachter: die Route merken (Erholung, Ruhe vor der
    /// Prüfung) und, solange wir halten, nachsehen, ob HQ danach noch läuft.
    func funkHqNachRoute() {
        let f = SpracheFunkHq.geteilt
        f.routeGesehen()
        if f.haelt { funkHqSpaeter(Self.funkPruefGrund, nach: Self.funkPruefFrist) }
    }

    /// Wie lange der Kopfhörer für den Wechsel auf HQ Zeit bekommt, bevor
    /// „springt nicht an" gilt. Geschätzt, nicht gemessen — der Abstand
    /// `funk_hq_an` → `funk_hq_gescheitert` im Bericht zeigt, ob er reicht.
    static let funkPruefFrist: TimeInterval = 3
    static let funkPruefGrund = "hq_pruefen"
    static let funkErholGrund = "erholung"

    /// Zurück an das SDK.
    ///
    /// **Die Reihenfolge, seit Gegenprüfung C5:** solange wir noch halten,
    /// ZUERST die Kategorie, wie das SDK sie setzen würde, DANN die
    /// Verarbeitung zurück, ZULETZT die Automatik. Umgekehrt (Automatik
    /// zuerst) richtete das SDK beim Wechsel der Verarbeitung selbst ein
    /// (`isPlatformVoiceProcessingExpected` → `onDidMutate` → `setCategory`),
    /// und zwar NACH dem Neubau der Maschine für VPIO: der Formatwechsel
    /// HQ → HFP träfe eine laufende Maschine, `ReconfigureEngine` liefe MIT
    /// Automatik, also mit `setActive(false)`/`(true)` und freigegebener
    /// fremder Musik. So läuft der Neubau, während das SDK die Session nicht
    /// anfasst, und danach gibt es für das SDK nichts mehr einzurichten.
    /// Hielten wir nicht mehr (`kopfhoererWeg` lässt sofort los — dort wiegt
    /// das Echo schwerer), richtet das SDK beim Wechsel der Verarbeitung selbst
    /// ein; ohne Wechsel setzen wir seine Werte, damit HQ nicht stehen bleibt.
    /// Gezählt werden die Neubauten in `konfigWechsel` (Diagnose).
    private func funkHqZurueck(_ spur: LocalAudioTrack?, istSoftware: Bool,
                               optionDa: Bool, grund: String) async {
        let f = SpracheFunkHq.geteilt
        let hielt = f.haelt
        let bleibtSoftware = ton.volle
        if hielt {
            await MainActor.run { f.sdkKategorieSetzen(software: bleibtSoftware, gehalten: true) }
        }
        if istSoftware, !bleibtSoftware {
            verarbeitungSetzen(spur, software: false)
        } else if !hielt, optionDa {
            await MainActor.run { f.sdkKategorieSetzen(software: istSoftware) }
        }
        if f.loslassen() || hielt { diagMelden("funk_hq_aus", ["grund": grund]) }
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
            "funkSprech": l.ausgangSprech,
        "hqKann": l.hqKann.map { $0 ? "ja" : "nein" } ?? "unbekannt",
            "hqAn": l.hqAn,
            "konfigWechsel": SpracheFunkHq.geteilt.konfigWechsel,
            "rate": Int(s.sampleRate),
            "eingKanaele": s.inputNumberOfChannels,
            "ausKanaele": s.outputNumberOfChannels
        ]
    }
}
