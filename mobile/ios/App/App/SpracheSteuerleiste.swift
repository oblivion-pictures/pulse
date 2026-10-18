import AVFoundation
import LiveKit
import SwiftUI

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
/// **Fünf Knöpfe, einzeilig — bei grosser Schrift zweizeilig.** Der
/// Kamera-Wechsel sitzt deshalb auf der eigenen Kachel (wie im Web,
/// `CLAUDE.md`: „der Front/Rück-Wechsel auf der
/// eigenen Kamerakachel"): sechs runde 56-pt-Knöpfe passen auf ein schmales
/// Telefon nicht nebeneinander.
struct SpracheSteuerleiste: View {
    @ObservedObject var raum: Room
    @ObservedObject private var stand = SpracheStand.geteilt
    let fehlerMelden: (SpracheMeldung) -> Void
    /// Eine Aktion ist gelungen: ein stehendes Band ist damit erledigt.
    let fehlerAufheben: () -> Void

    /// Spiegel der Vorgabe des SDK (`isSpeakerOutputPreferred`). Sie ist keine
    /// beobachtbare Eigenschaft, deshalb ein eigener Stand, beim Erscheinen
    /// abgelesen. **Es ist der WUNSCH, nicht die Route** — die wirkliche Route
    /// meldet `eigenerZustand` (sie wechselt asynchron, 8–17 ms, am Gerät
    /// gemessen). Bluetooth und AirPlay bleiben Sache des Systems.
    @State private var lautsprecher = true
    /// Die wirkliche Route (`SpracheAusgabe`); bei Bluetooth, Kopfhörer und
    /// Co. öffnet der Ausgabe-Knopf den System-Routenwähler statt zwischen
    /// Hörmuschel und Lautsprecher zu schalten.
    @State private var route = SpracheAusgabe.aktuell()
    @State private var waehlerAusloeser = 0

    private var mikroAn: Bool { raum.localParticipant.isMicrophoneEnabled() }
    private var kameraAn: Bool { raum.localParticipant.isCameraEnabled() }

    var body: some View {
        // **Von der Moderation geschaltet: gesperrt, mit Schild.** Bis zum
        // 2026-10-11 sah der Knopf aus wie bei eigener Stummschaltung, und ein
        // Tipp tat still nichts — das Web lehnt das Einschalten ab
        // (`toggleMic`), sagt es aber niemandem. Die Web-Leiste sperrt ihn
        // genauso (`VoiceControlBar.svelte`).
        let zwang = stand.erzwungen(fuer: raum.localParticipant)
        // **Eine Zeile, wenn sie passt, sonst zwei.** Bei grosser Schrift
        // wachsen die Knöpfe mit (`SpracheRundKnopf`), und fünf nebeneinander
        // liefen über den Rand; `ViewThatFits` nimmt die erste Fassung, die
        // in die Breite passt.
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) {
                mikroKnopf(zwang: zwang.stumm)
                taubKnopf(zwang: zwang.taub)
                kameraKnopf
                ausgabeKnopf
                auflegenKnopf
            }
            VStack(spacing: 14) {
                HStack(spacing: 14) {
                    mikroKnopf(zwang: zwang.stumm)
                    taubKnopf(zwang: zwang.taub)
                    kameraKnopf
                }
                HStack(spacing: 14) {
                    ausgabeKnopf
                    auflegenKnopf
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(SpracheRoutenWaehler(ausloeser: waehlerAusloeser).frame(width: 1, height: 1))
        .onAppear {
            lautsprecher = AudioManager.shared.isSpeakerOutputPreferred
            route = SpracheAusgabe.aktuell()
        }
        .onReceive(
            NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)
                .receive(on: DispatchQueue.main)
        ) { _ in route = SpracheAusgabe.aktuell() }
    }

    // MARK: - Die Knöpfe

    private func mikroKnopf(zwang: Bool) -> some View {
        let mikroOffen = mikroAn && !zwang
        return SpracheRundKnopf(
            symbol: mikroOffen ? "mic.fill" : "mic.slash.fill",
            an: mikroOffen, warnend: !mikroOffen, gesperrt: zwang,
            beschriftung: mikroBeschriftung(erzwungen: zwang),
            hinweis: NSLocalizedString("Schaltet dein Mikrofon im Kanal ein oder aus.", comment: "Sprachkanal"),
            kennung: "sprache.mikrofon"
        ) {
            SpracheRaum.geteilt.wunschEinreihen(.mikrofon, an: !mikroAn, fertig: gemeldet("mikrofon"))
        }
    }

    private func taubKnopf(zwang: Bool) -> some View {
        SpracheRundKnopf(
            symbol: stand.taub ? "speaker.slash.fill" : "headphones",
            an: false, warnend: stand.taub, gesperrt: zwang,
            beschriftung: taubBeschriftung(erzwungen: zwang),
            hinweis: NSLocalizedString("Schaltet ein oder aus, ob du die anderen im Kanal hörst.", comment: "Sprachkanal"),
            kennung: "sprache.taub"
        ) {
            SpracheRaum.geteilt.wunschEinreihen(.taub, an: !stand.taub, fertig: gemeldet("taub"))
        }
    }

    private var kameraKnopf: some View {
        SpracheRundKnopf(
            symbol: kameraAn ? "video.fill" : "video.slash.fill",
            an: kameraAn, warnend: false,
            beschriftung: kameraAn
                ? NSLocalizedString("Kamera ausschalten", comment: "Sprachkanal")
                : NSLocalizedString("Kamera einschalten", comment: "Sprachkanal"),
            hinweis: NSLocalizedString("Schaltet deine Kamera im Kanal ein oder aus.", comment: "Sprachkanal"),
            kennung: "sprache.kamera"
        ) {
            // Der Stand wird erst in der Kette gelesen: zwei schnelle
            // Tipps schalten so an und wieder aus, nicht zweimal an.
            SpracheRaum.geteilt.einreihen({
                try await SpracheRaum.geteilt.kamera(!kameraAn)
            }, fertig: gemeldet("kamera"))
        }
    }

    private var auflegenKnopf: some View {
        SpracheRundKnopf(
            symbol: "phone.down.fill", an: false, warnend: true,
            beschriftung: NSLocalizedString("Auflegen", comment: "Sprachkanal"),
            hinweis: NSLocalizedString("Verlässt den Sprachkanal.", comment: "Sprachkanal"),
            kennung: "sprache.auflegen", haptik: .auflegen
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

    /// Läuft der Ton über Bluetooth, Kopfhörer oder eine andere externe Route,
    /// zeigt der Knopf DIESE und öffnet beim Tippen den System-Routenwähler —
    /// das Umschalten Hörmuschel/Lautsprecher bliebe dort ohne Wirkung. Ohne
    /// externes Gerät wie bisher.
    @ViewBuilder
    private var ausgabeKnopf: some View {
        if let symbol = route.symbol {
            SpracheRundKnopf(
                symbol: symbol, an: true, warnend: false,
                beschriftung: route.beschriftung,
                hinweis: NSLocalizedString("Öffnet die Auswahl der Tonausgabe.", comment: "Sprachkanal"),
                kennung: "sprache.ausgabe"
            ) {
                waehlerAusloeser += 1
            }
        } else {
            SpracheRundKnopf(
                symbol: lautsprecher ? "speaker.wave.2.fill" : "ear",
                an: !lautsprecher, warnend: false,
                beschriftung: lautsprecher
                    ? NSLocalizedString("Auf Hörmuschel umschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Auf Lautsprecher umschalten", comment: "Sprachkanal"),
                hinweis: NSLocalizedString("Wechselt zwischen Lautsprecher und Hörmuschel.", comment: "Sprachkanal"),
                kennung: "sprache.ausgabe"
            ) {
                let neu = !lautsprecher
                SpracheRaum.geteilt.ausgabe(neu ? "lautsprecher" : "hoermuschel")
                lautsprecher = neu
            }
        }
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
    ///
    /// Das Band zeigt verständlichen Text in der Sprache des Geräts
    /// (`SpracheMeldung`), die Rohfassung steht im Log. Gelingt eine Aktion,
    /// geht ein stehendes Band weg.
    private func gemeldet(_ knopf: String) -> (Result<Void, Error>) -> Void {
        let fehlerMelden = fehlerMelden
        let fehlerAufheben = fehlerAufheben
        return { ergebnis in
            switch ergebnis {
            case .success:
                DispatchQueue.main.async { fehlerAufheben() }
            case .failure(let fehler):
                NSLog("[PulseSprache] Knopf '%@' fehlgeschlagen: %@", knopf, fehler.localizedDescription)
                let meldung = SpracheMeldung.aus(fehler, knopf: knopf)
                DispatchQueue.main.async { fehlerMelden(meldung) }
            }
        }
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
        if await anWebGereicht(w, an: an) { return }
        switch w {
        case .mikrofon: try await nacheinander { try await self.mikrofon(an) }
        case .taub: try await nacheinander { await self.taubStellen(an) }
        case .auflegen: await selbstAuflegen()
        // Neu verbinden braucht ein frisches Token, und das holt nur das Web.
        // Hört es nicht zu, bleibt der Raum, wie er ist.
        case .neuVerbinden: break
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
            if await self.anWebGereicht(w, an: an) { return }
            switch w {
            case .mikrofon: try await self.mikrofon(an)
            case .taub: await self.taubStellen(an)
            case .auflegen: await self.selbstAuflegen()
            case .neuVerbinden: break
            }
        }, fertig: fertig)
    }

    /// Reicht den Wunsch ans Web. `true`, wenn dort jemand zuhört — dann
    /// befiehlt das Web, und beim Auflegen sichert die Hülle ab.
    private func anWebGereicht(_ w: Wunsch, an: Bool) async -> Bool {
        guard await wunschAnWeb?(w, an) == true else { return false }
        if w == .auflegen { auflegenAbsichern() }
        return true
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
