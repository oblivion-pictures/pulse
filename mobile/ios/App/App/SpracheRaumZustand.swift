import AVFoundation
import LiveKit

/// Der Zustands- und Melde-Teil von `SpracheRaum` — was nach oben geht und in
/// welcher Form.
///
/// Eigene Datei wegen der Grössen-Policy (`PLAN.md` §12.1): hier steht
/// nichts, was etwas tut, nur was etwas berichtet. `private` ist in Swift
/// DATEI-weit, deshalb sind die Glieder intern statt privat.
extension SpracheRaum {
    func zustand() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        let felder: [String: Any] = [
            "verbunden": raum?.connectionState == .connected,
            "kanalId": kanalId ?? "",
            // Für den Abgleich nach einem Reload: die frische Oberfläche kennt
            // den Kanalnamen nicht, und ohne die Sitzung könnte sie beim
            // Verlassen nicht sagen, WELCHEN Raum sie meint.
            "kanalName": kanalName,
            "sitzung": sitzung,
            // In der Hülle aufgelegt (B1) — `SpracheRaum.vomNutzerAufgelegt`.
            "aufgelegtSitzung": aufgelegtSitzung ?? NSNull(),
            "teilnehmer": teilnehmerListe(),
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            // Kamera- und Taub-Stand gehören in dasselbe Vollbild: nach einem
            // Reload der Web-App ist `zustand()` die EINZIGE Quelle, aus der
            // sich Kamera-Knopf und Kopfhörer-Knopf in der Leiste wieder
            // richtig stellen können.
            "kamera": raum?.localParticipant.isCameraEnabled() ?? false,
            "kameraVorn": kameraVorn,
            // Der WIRKSAME Stand: während eines Anrufs hört man den Kanal
            // nicht, auch wenn man nicht taub gestellt hat
            // (`SpracheRaumStumm.swift`). `pausiert` sagt, warum.
            "taub": wirksamTaub,
            "pausiert": anrufPausiert,
            "ansichtOffen": SpracheAnsichtHalter.geteilt.istOffenSynchron,
            // Leer, solange alles in Ordnung ist. Ein Beitritt OHNE Mikrofon ist
            // kein gescheiterter Beitritt (man kann zuhören) — aber er muss
            // sichtbar sein, sonst hält sich der Nutzer für zu hören.
            "mikrofonFehler": mikrofonFehler ?? NSNull(),
            // Der Wächter hat aufgegeben — nach einem Reload der WebView die
            // einzige Quelle für das Band „Mikrofon ausgefallen".
            "mikroTot": wache.tot,
            "lautsprecher": AudioManager.shared.isSpeakerOutputPreferred,
            "route": routeJetzt(),
            // **Kategorie und Optionen gehören in den Zustand.** Am 2026-10-10
            // war von aussen nicht zu sagen, WER die Session umgestellt hatte;
            // `.defaultToSpeaker` macht die Hörmuschel unerreichbar.
            "kategorie": session.category.rawValue,
            "modus": session.mode.rawValue,
            "optionen": optionenNamen(),
            // „Spielt eine FREMDE App?" — nur das: es blieb `false`, während
            // WebKit unsere Session an sich zog (2026-10-10). Für die eigene
            // WebView ist `eingaenge` da.
            "fremdTon": session.isOtherAudioPlaying,
            // Laeuft die Audio-Maschine noch? Nach einer Unterbrechung steht
            // sie, und eine stehende Session bewegt keine Route.
            "engineLaeuft": AudioManager.shared.isEngineRunning,
            // Eingaenge als Anzeiger dafuer, ob die Session wirklich AKTIV
            // ist: eine nicht aktivierte `.playAndRecord`-Session fuehrt
            // keinen Eingang, und „aktiv?" fragt `AVAudioSession` nicht ab.
            "eingaenge": session.currentRoute.inputs.map { $0.portType.rawValue }
        ]
        return felder.merging(wunschFelder) { $1 }
    }

    func optionenNamen() -> [String] {
        let o = AVAudioSession.sharedInstance().categoryOptions
        var namen: [String] = []
        if o.contains(.defaultToSpeaker) { namen.append("defaultToSpeaker") }
        if o.contains(.allowBluetoothHFP) { namen.append("allowBluetoothHFP") }
        if o.contains(.allowBluetoothA2DP) { namen.append("allowBluetoothA2DP") }
        if o.contains(.mixWithOthers) { namen.append("mixWithOthers") }
        return namen
    }

    /// Was die Session gerade WIRKLICH ausgibt — nicht, was gewünscht ist.
    /// Der Unterschied war am 2026-10-10 der ganze Befund.
    func routeJetzt() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "(keiner)"
    }

    /// **Die Reihenfolge ist Teil der Form.** Der Web-Weg sortiert in
    /// `teilnehmer.ts::teilnehmerListe` eigener Nutzer zuerst, dann nach Namen mit einem
    /// `Intl.Collator`; die Oberfläche sortiert nicht nach. Käme die Liste von
    /// hier unsortiert, sprängen die Zeilen bei jedem `teilnehmer`-Ereignis
    /// umher — `remoteParticipants` ist ein Dictionary, seine Aufzählung ist
    /// nicht stabil. `localizedStandardCompare` ist das nächstliegende
    /// Gegenstück zum Collator (Gross/Klein und Umlaute wie im Telefonbuch).
    func teilnehmerListe() -> [[String: Any]] {
        guard let r = raum else { return [] }
        var liste = [abbilden(r.localParticipant, lokal: true)]
        let fremde = r.remoteParticipants.values
            .map { abbilden($0, lokal: false) }
            .sorted {
                let a = $0["name"] as? String ?? ""
                let b = $1["name"] as? String ?? ""
                return a.localizedStandardCompare(b) == .orderedAscending
            }
        liste.append(contentsOf: fremde)
        return liste
    }

    /// Abbildung auf die Form, die der Web-Store schon kennt
    /// (`VoiceParticipant` in `voice/livekit.svelte.ts`) — damit die 31
    /// Dateien, die ihn benutzen, unverändert bleiben.
    ///
    /// **`micMuted` ist nachgeprüft:** `isMicrophoneEnabled()` ist im SDK
    /// `!(Mikrofon-Publikation?.isMuted ?? true)` — ohne veröffentlichte Spur
    /// gilt man als stumm, wie im Web-Weg. Deshalb schickt `beitreten` die
    /// Liste erst NACH dem Veröffentlichen.
    ///
    /// **`isSpeaking` kommt hier vom SERVER, im Web nicht.** Der Web-Weg
    /// rechnet es aus einem `AnalyserNode` über der abonnierten Spur, mit der
    /// Begründung, LiveKits serverseitige Erkennung sei bei abgeschalteter AGC
    /// unzuverlässig. Auf dem nativen Weg gibt es keinen Web-Audio-Graphen; die
    /// Server-Erkennung ist, was da ist. **Ob sie merklich schlechter trifft,
    /// ist nicht gemessen.**
    func abbilden(_ p: Participant, lokal: Bool) -> [String: Any] {
        let kennung = p.identity?.stringValue ?? ""
        // Dieselbe Regel wie `voice/identity.ts::nameFor` — ein LEERER Name
        // zählt als keiner: geprüft wird der GETRIMMTE Name, weitergegeben der
        // rohe (genau so macht es der Web-Weg). Ein blosses `p.name ?? kennung`
        // liesse "" durch, und die Zeile stünde namenlos da.
        let name = p.name ?? ""
        let hatNamen = !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return [
            "identity": kennung,
            "name": hatNamen ? name : kennung,
            "userId": Self.nutzerId(aus: kennung) ?? NSNull(),
            "isLocal": lokal,
            "isSpeaking": p.isSpeaking,
            "audioLevel": Double(p.audioLevel),
            "micMuted": !p.isMicrophoneEnabled(),
            "cameraOn": p.isCameraEnabled(),
            "connectionQuality": guete(p.connectionQuality)
        ]
    }

    /// `user-<snowflake>` oder `user-<snowflake>~<zufall>` → die nackte Id.
    ///
    /// **Dieselbe Regel wie `voice/identity.ts::userIdFromIdentity`**
    /// (`^user-(\d+)(?:~[0-9a-f]+)?$`). Bis zum 2026-10-11 schnitt die Hülle
    /// nur `user-` ab und liess den Sitzungs-Zusatz stehen, den jeder Beitritt
    /// seit der Mehrgerät-Freischaltung trägt — `userId` war damit
    /// `"123~ab12"`, und alles, was im Web an der Id hängt (Profil, Lautstärke
    /// je Teilnehmer, Admin-Stummschaltung), fand niemanden.
    static func nutzerId(aus kennung: String) -> String? {
        guard kennung.hasPrefix("user-") else { return nil }
        let teile = kennung.dropFirst(5).split(
            separator: "~", maxSplits: 1, omittingEmptySubsequences: false)
        let zahl = teile[0]
        guard !zahl.isEmpty, zahl.allSatisfy({ ("0" ... "9").contains($0) }) else { return nil }
        if teile.count == 2 {
            let zusatz = teile[1]
            guard !zusatz.isEmpty, zusatz.allSatisfy({ "0123456789abcdef".contains($0) })
            else { return nil }
        }
        return String(zahl)
    }

    /// Der Verbindungszustand als schlichtes Wort — **an genau dieser Stelle**.
    /// Bis zum 2026-10-11 ging `"\(state)"` hinüber, und LiveKits
    /// `description` trägt einen Punkt (`.connected`): das Web prüfte auf
    /// `connected`, ein Wiederaufbau wurde nie angezeigt (Bughunt G1). Das Web
    /// liest tolerant (`voice/nativAbgleich.ts`) — ältere Hüllen schicken ihn.
    static func verbindungsName(_ s: ConnectionState) -> String {
        switch s {
        case .disconnected: return "disconnected"
        case .connecting: return "connecting"
        case .reconnecting: return "reconnecting"
        case .connected: return "connected"
        case .disconnecting: return "disconnecting"
        }
    }

    func guete(_ q: ConnectionQuality) -> String {
        switch q {
        case .excellent: return "excellent"
        case .good: return "good"
        case .poor: return "poor"
        case .lost: return "lost"
        default: return "unknown"
        }
    }

    func schickeTeilnehmer() {
        melden("teilnehmer", ["liste": teilnehmerListe()])
    }

    func schickeEigenen() {
        // Mikrofon, Stumm oder Route haben sich geändert: die Echo-Absenkung
        // des Stream-Tons sofort nachziehen, nicht erst im Takt (S9).
        StreamTonVerwaltung.geteilt.echoAnstossen()
        melden("eigenerZustand", [
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "kamera": raum?.localParticipant.isCameraEnabled() ?? false,
            "kameraVorn": kameraVorn,
            "taub": wirksamTaub,
            "pausiert": anrufPausiert,
            "lautsprecher": AudioManager.shared.isSpeakerOutputPreferred,
            "route": routeJetzt()
        ].merging(wunschFelder) { $1 })
    }
}
