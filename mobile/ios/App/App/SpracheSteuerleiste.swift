import LiveKit
import SwiftUI

/// Was die Ansicht beobachten muss, das kein `ObservableObject` des SDK
/// trägt: `taub` lebt in der Hülle (`SpracheRaum.taub`), die
/// Admin-Stummschaltung im Web (`SprachePlugin.erzwungen`). Geschrieben nur auf
/// dem Hauptthread.
final class SpracheStand: ObservableObject {
    static let geteilt = SpracheStand()
    @Published var taub = false
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

/// Die Knopfreihe der nativen Kanalansicht.
///
/// **Warum es sie überhaupt gibt, obwohl die Sprachleiste im Web lebt**
/// (Entwurf §2): die native Ansicht liegt ÜBER der WebView — solange sie steht,
/// ist die Web-Leiste nicht erreichbar. Eine Ansicht ohne eigene Knöpfe wäre
/// also eine, in der man nicht stummschalten kann.
///
/// **Mikrofon, Taub und Auflegen fragen das Web** (`SpracheRaum.wunschEinreihen`
/// bzw. `wunsch`): ihre Regeln (Admin-Stummschaltung, Sprechtaste,
/// Watch-Party, Wiederaufnahme) liegen dort. Bis zum 2026-10-11 fehlten Taub und Auflegen
/// hier ganz, mit einer Begründung, die nicht mehr stimmte — die Brücke hatte
/// `taub` längst, und „Auflegen gehört dem Web" heisst nicht, dass der Knopf
/// fehlen muss, sondern dass er das Web bittet. Kamera und Ausgabe schalten
/// direkt: an ihnen hängt keine Regel des Webs.
///
/// **Fünf Knöpfe, einzeilig.** Der Kamera-Wechsel sitzt deshalb auf der
/// eigenen Kachel (wie im Web, `CLAUDE.md`: „der Front/Rück-Wechsel auf der
/// eigenen Kamerakachel"): sechs runde 56-pt-Knöpfe passen auf ein schmales
/// Telefon nicht nebeneinander.
struct SpracheSteuerleiste: View {
    @ObservedObject var raum: Room
    @ObservedObject private var stand = SpracheStand.geteilt
    let fehlerMelden: (String) -> Void

    /// Spiegel der Vorgabe des SDK (`isSpeakerOutputPreferred`). Sie ist keine
    /// beobachtbare Eigenschaft, deshalb ein eigener Stand, beim Erscheinen
    /// abgelesen. **Es ist der WUNSCH, nicht die Route** — die wirkliche Route
    /// meldet `eigenerZustand` (sie wechselt asynchron, 8–17 ms, am Gerät
    /// gemessen). Bluetooth und AirPlay bleiben Sache des Systems.
    @State private var lautsprecher = true

    private var mikroAn: Bool { raum.localParticipant.isMicrophoneEnabled() }
    private var kameraAn: Bool { raum.localParticipant.isCameraEnabled() }

    var body: some View {
        // **Von der Moderation geschaltet: gesperrt, mit Schild.** Bis zum
        // 2026-10-11 sah der Knopf aus wie bei eigener Stummschaltung, und ein
        // Tipp tat still nichts — das Web lehnt das Einschalten ab
        // (`toggleMic`), sagt es aber niemandem. Die Web-Leiste sperrt ihn
        // genauso (`VoiceControlBar.svelte`).
        let zwang = stand.erzwungen(fuer: raum.localParticipant)
        let mikroOffen = mikroAn && !zwang.stumm
        return HStack(spacing: 14) {
            knopf(
                symbol: mikroOffen ? "mic.fill" : "mic.slash.fill",
                an: mikroOffen, warnend: !mikroOffen, gesperrt: zwang.stumm,
                beschriftung: mikroBeschriftung(erzwungen: zwang.stumm), kennung: "sprache.mikrofon"
            ) {
                SpracheRaum.geteilt.wunschEinreihen(.mikrofon, an: !mikroAn, fertig: gemeldet("mikrofon"))
            }
            knopf(
                symbol: stand.taub ? "speaker.slash.fill" : "headphones",
                an: false, warnend: stand.taub, gesperrt: zwang.taub,
                beschriftung: taubBeschriftung(erzwungen: zwang.taub), kennung: "sprache.taub"
            ) {
                SpracheRaum.geteilt.wunschEinreihen(.taub, an: !stand.taub, fertig: gemeldet("taub"))
            }
            knopf(
                symbol: kameraAn ? "video.fill" : "video.slash.fill",
                an: kameraAn, warnend: false,
                beschriftung: kameraAn
                    ? NSLocalizedString("Kamera ausschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Kamera einschalten", comment: "Sprachkanal"),
                kennung: "sprache.kamera"
            ) {
                // Der Stand wird erst in der Kette gelesen: zwei schnelle
                // Tipps schalten so an und wieder aus, nicht zweimal an.
                SpracheRaum.geteilt.einreihen({
                    try await SpracheRaum.geteilt.kamera(!kameraAn)
                }, fertig: gemeldet("kamera"))
            }
            knopf(
                symbol: lautsprecher ? "speaker.wave.2.fill" : "ear",
                an: !lautsprecher, warnend: false,
                beschriftung: lautsprecher
                    ? NSLocalizedString("Auf Hörmuschel umschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Auf Lautsprecher umschalten", comment: "Sprachkanal"),
                kennung: "sprache.ausgabe"
            ) {
                let neu = !lautsprecher
                SpracheRaum.geteilt.ausgabe(neu ? "lautsprecher" : "hoermuschel")
                lautsprecher = neu
            }
            knopf(
                symbol: "phone.down.fill", an: false, warnend: true,
                beschriftung: NSLocalizedString("Auflegen", comment: "Sprachkanal"),
                kennung: "sprache.auflegen"
            ) {
                // **Auflegen bleibt ausserhalb der Kette**, wie `verlassen`:
                // es darf nicht hinter einem hängenden Befehl warten
                // (`SpracheRaum.nacheinander`). Ein eigener Task ist hier also
                // Absicht, keine Reihenfolge-Lücke.
                Task {
                    do {
                        try await SpracheRaum.geteilt.wunsch(.auflegen, an: true)
                    } catch {
                        gemeldet("auflegen")(.failure(error))
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .onAppear { lautsprecher = AudioManager.shared.isSpeakerOutputPreferred }
    }

    /// Ein runder Knopf. **Rund, weil Anruf-Steuerungen rund sind** — dieselbe
    /// Begründung wie in `VoiceControlBar.svelte`, und 56 pt ist dort das Mass
    /// fürs Telefon (48 pt wäre die Untergrenze der Trefferflächen-Regel).
    private func knopf(
        symbol: String,
        an: Bool,
        warnend: Bool,
        gesperrt: Bool = false,
        beschriftung: String,
        kennung: String,
        tun: @escaping () -> Void
    ) -> some View {
        Button(action: tun) {
            // Auf Rot und Blau weiss, in Ruhe in der Schriftfarbe des Themas —
            // die dunkle Schrift des hellen Satzes wäre auf Blau unlesbar.
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(warnend || an ? Color.white : SpracheFarben.text)
                .frame(width: 56, height: 56)
                .background(hintergrund(an: an, warnend: warnend), in: Circle())
                .overlay(alignment: .bottomTrailing) {
                    if gesperrt {
                        Image(systemName: "shield.fill")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(SpracheFarben.schild)
                    }
                }
        }
        .disabled(gesperrt)
        .accessibilityLabel(beschriftung)
        // Für die XCUITests (`AppUITests/UITests.swift`): die Beschriftung
        // ist übersetzt und wechselt mit dem Zustand, die Kennung nicht.
        .accessibilityIdentifier(kennung)
    }

    /// Das Ende eines Knopfdrucks, der Arbeit anstösst. **Jeder Fehlschlag wird
    /// sichtbar.** Ein verschluckter Fehler ist hier der teuerste Zustand: der
    /// Knopf sähe geschaltet aus, und nichts hätte sich geändert. Im Simulator
    /// ist genau das der Normalfall (kein Mikrofon, keine Kamera).
    ///
    /// **Eingereiht wird beim Tipp, synchron** (Nachzügler aus Bughunt 2, wie
    /// B5 für die Brücke): Mikrofon, Taub und Kamera stellen ihre Arbeit über
    /// `SpracheRaum.einreihen` in die Befehlskette, nicht aus je einem eigenen
    /// `Task` — zwei solche Tasks starten in keiner zugesagten Reihenfolge.
    /// Auflegen bleibt bewusst ausserhalb (Begründung am Knopf).
    private func gemeldet(_ knopf: String) -> (Result<Void, Error>) -> Void {
        let fehlerMelden = fehlerMelden
        return { ergebnis in
            guard case .failure(let fehler) = ergebnis else { return }
            NSLog("[PulseSprache] Knopf '%@' fehlgeschlagen: %@", knopf, fehler.localizedDescription)
            DispatchQueue.main.async { fehlerMelden(fehler.localizedDescription) }
        }
    }

    private func hintergrund(an: Bool, warnend: Bool) -> Color {
        if warnend { return SpracheFarben.schlecht }
        return an ? SpracheFarben.marke : SpracheFarben.knopf
    }

    /// Von der Moderation geschaltet geht vor — dann sagt der Knopf, warum er
    /// gesperrt ist, statt was ein Tippen täte.
    private func mikroBeschriftung(erzwungen: Bool) -> String {
        if erzwungen {
            return NSLocalizedString("Vom Mod stummgeschaltet", comment: "Sprachkanal")
        }
        return mikroAn
            ? NSLocalizedString("Mikrofon stummschalten", comment: "Sprachkanal")
            : NSLocalizedString("Mikrofon einschalten", comment: "Sprachkanal")
    }

    private func taubBeschriftung(erzwungen: Bool) -> String {
        if erzwungen {
            return NSLocalizedString("Vom Mod taubgeschaltet", comment: "Sprachkanal")
        }
        return stand.taub
            ? NSLocalizedString("Mithören einschalten", comment: "Sprachkanal")
            : NSLocalizedString("Nicht mehr mithören", comment: "Sprachkanal")
    }
}

// MARK: - Knöpfe, deren Regeln dem Web gehören

extension SpracheRaum {
    /// Ein Knopfdruck in der nativen Ansicht, dessen REGELN im Web liegen.
    ///
    /// **Warum nicht direkt.** Mikrofon, Taubstellen und Auflegen hängen an
    /// Regeln, die nur das Web kennt: ein Admin-Stummschalten darf die
    /// Ansicht nicht aufheben, Taub nimmt das Mikrofon mit und gibt es danach
    /// zurück (nicht bei der Sprechtaste), Auflegen beendet eine gehostete
    /// Watch-Party und löscht den Eintrag fürs Wiederaufnehmen. Bis zum
    /// 2026-10-11 schaltete der Mikrofon-Knopf hier direkt — und hob damit
    /// ein Admin-Stummschalten auf. Ein zweiter Weg zum selben Ziel läuft
    /// auseinander; deshalb geht der Wunsch ans Web, und das Web befiehlt.
    ///
    /// **Hört dort niemand zu** (Prüfpfad, Oberfläche lädt gerade neu), tut die
    /// Hülle es selbst — ein Knopf, der nichts tut, ist schlimmer als keiner.
    func wunsch(_ w: Wunsch, an: Bool) async throws {
        if await wunschAnWeb?(w, an) == true {
            if w == .auflegen { auflegenAbsichern() }
            return
        }
        switch w {
        case .mikrofon: try await nacheinander { try await self.mikrofon(an) }
        case .taub: try await nacheinander { await self.taubStellen(an) }
        case .auflegen: await selbstAuflegen()
        }
    }

    /// Wie `wunsch` für Mikrofon und Taub, aber schon beim Ruf eingereiht: der
    /// Wunsch ans Web ist selbst ein Glied der Kette. Zwei schnelle Tipps
    /// erreichen das Web so in ihrer Reihenfolge, und ein Befehl, den das Web
    /// daraufhin schickt, reiht sich hinter ihnen ein. Hört das Web nicht zu,
    /// schaltet die Hülle hier selbst — direkt, denn sie IST schon in der Kette
    /// (`nacheinander` von hier aus wartete auf sich selbst).
    ///
    /// Auflegen gehört nicht hierher, s. `nacheinander`.
    func wunschEinreihen(_ w: Wunsch, an: Bool, fertig: @escaping (Result<Void, Error>) -> Void) {
        einreihen({
            if await self.wunschAnWeb?(w, an) == true {
                if w == .auflegen { self.auflegenAbsichern() }
                return
            }
            switch w {
            case .mikrofon: try await self.mikrofon(an)
            case .taub: await self.taubStellen(an)
            case .auflegen: await self.selbstAuflegen()
            }
        }, fertig: fertig)
    }

    /// **Auflegen muss immer gehen.** Antwortet das Web nicht binnen vier
    /// Sekunden (eingefroren, abgestürzt), legt die Hülle selbst auf.
    private func auflegenAbsichern() {
        let gemeint = sitzung
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard raum != nil, sitzung == gemeint else { return }
            NSLog("[PulseSprache] Auflegen: keine Antwort der Oberflaeche — die Huelle legt auf")
            await selbstAuflegen()
        }
    }

    /// Verlassen und es melden — die Delegat-Ereignisse des alten Raums gehen
    /// nach dem Verlassen nirgends mehr hin (`room === raum`-Wächter), also
    /// sagt es die Hülle selbst. Die Oberfläche räumt daraufhin ab wie nach
    /// einem Abbruch von aussen.
    private func selbstAuflegen() async {
        guard raum != nil else { return }
        await vomNutzerAufgelegt()
        melden("verbindung", ["zustand": "disconnected"])
    }
}
