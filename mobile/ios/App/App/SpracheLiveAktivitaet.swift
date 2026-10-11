import ActivityKit
import Foundation
import LiveKit

/// Die Live Activity „Im Sprachkanal“ (Roadmap Punkt 28): Sperrbildschirm und
/// Dynamic Island zeigen, in welchem Kanal man sitzt, wer spricht und ob das
/// eigene Mikrofon offen ist — ab iOS 17 mit Knöpfen für Stumm und Verlassen.
/// Die Darstellung liegt in der Widget-Erweiterung (`SpracheAktivitaetWidget`),
/// die Form in `Gemeinsam/SpracheAktivitaetDaten.swift`.
///
/// **Die Quelle ist der native Raum, nicht das Web.** Begonnen wird am Ende
/// von `SpracheRaum.beitreten`, beendet in `raumLoesen`, aufgefrischt bei
/// jeder Meldung des Raums (`SpracheRaum.melden`). Die Oberfläche braucht es
/// dafür nicht — sie ist im Hintergrund eingefroren, und genau dann ist die
/// Aktivität zu sehen. Der Stand wird jedes Mal am Raum GELESEN, nicht aus
/// einer Meldung übernommen.
///
/// **Gedrosselt.** ActivityKit drosselt selbst, wenn eine App zu oft
/// aktualisiert (Apple nennt keine Zahl), und die Sprechanzeige kippt
/// mehrmals je Sekunde. Deshalb höchstens alle `mindestAbstand` Sekunden; der
/// LETZTE Stand kommt immer an (nachlaufend), ein unveränderter gar nicht. Nur
/// ein Knopfdruck auf der Aktivität selbst geht sofort durch — wer auf „stumm“
/// tippt, will das Zeichen kippen sehen.
///
/// **Ein Anruf bekommt keine eigene Aktivität** (Auftrag): CallKit zeigt ihn
/// schon. Hält er den Kanal an, zeigt dessen Aktivität „angehalten“.
///
/// Alle Felder nur auf dem Hauptthread; die statischen Einstiege dürfen von
/// jedem Faden kommen (LiveKits Delegat-Rufe tun es) und reihen sich dort ein —
/// bis auf `beimBeendenDerApp`, das keine Felder anfasst und am rufenden Faden
/// wartet.
final class SpracheLiveAktivitaet {
    static let geteilt = SpracheLiveAktivitaet()

    /// Nicht gemessen, sondern vorsichtig gewählt: Apple dokumentiert keine
    /// Grenze für lokale Aktualisierungen, nur, dass zu häufige gedrosselt
    /// werden. Zwei Sekunden halten die Sprechanzeige noch lesbar.
    static let mindestAbstand: TimeInterval = 2

    private var aktivitaet: Activity<SpracheAktivitaet>?
    /// Die Sitzung des Raums (`SpracheRaum.sitzung`), zu dem sie gehört — ein
    /// verspätetes Ende des vorigen Raums darf die neue nicht treffen.
    private var sitzung: Int?
    private var gezeigt: SpracheAktivitaet.ContentState?
    private var zuletzt = Date.distantPast
    private var nachlauf: DispatchWorkItem?
    /// ActivityKit-Rufe der Reihe nach: ein Ende darf eine noch laufende
    /// Aktualisierung nicht überholen, sonst stünde die Aktivität wieder da.
    private var kette: Task<Void, Never>?

    // MARK: - Einstiege (jeder Faden)

    /// Beim Start der App (`AppDelegate`). Hängt die Knöpfe ein und räumt ab,
    /// was ein früherer Lauf stehen liess: ein Raum überlebt den Prozess nie,
    /// eine Aktivität schon (Absturz, Beenden aus dem App-Umschalter).
    static func einrichten() {
        SpracheAktivitaetSteuerung.ausfuehren = { befehl in
            await SpracheRaum.geteilt.ausLiveAktivitaet(befehl)
        }
        DispatchQueue.main.async { geteilt.alleBeenden("Start der App") }
    }

    static func beginnen(kanalName: String, communityName: String, sitzung: Int) {
        DispatchQueue.main.async {
            geteilt.beginnen(kanalName: kanalName, communityName: communityName, sitzung: sitzung)
        }
    }

    static func anstossen(sofort: Bool = false) {
        DispatchQueue.main.async { geteilt.anstossen(sofort: sofort) }
    }

    static func beenden(sitzung: Int) {
        DispatchQueue.main.async { geteilt.beenden(sitzung: sitzung) }
    }

    /// Die App wird beendet (`applicationWillTerminate`, etwa beim Wegwischen
    /// im App-Umschalter, während der Kanal im Hintergrund läuft). Der Raum
    /// stirbt mit dem Prozess; die Aktivität bliebe sonst stehen und
    /// behauptete einen Kanal, in dem man nicht mehr sitzt. **Höchstens eine
    /// Sekunde** — iOS gibt dem Beenden wenige Sekunden, und `end` ist
    /// asynchron. Reicht es nicht, räumt der nächste Start ab (`einrichten`).
    static func beimBeendenDerApp() {
        let alle = Activity<SpracheAktivitaet>.activities
        guard !alle.isEmpty else { return }
        let fertig = DispatchSemaphore(value: 0)
        Task.detached {
            for a in alle { await schliessen(a) }
            fertig.signal()
        }
        _ = fertig.wait(timeout: .now() + 1)
    }

    // MARK: - Hauptthread

    private func beginnen(kanalName: String, communityName: String, sitzung: Int) {
        // Höchstens eine. Die Liste VOR dem Anfordern lesen — danach stünde
        // die neue mit darin und würde gleich wieder beendet.
        alleBeenden("neuer Kanal")
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            NSLog("[PulseAktivitaet] Live Activities sind in den Einstellungen aus — keine gestartet")
            return
        }
        guard let stand = standJetzt() else { return }
        let form = SpracheAktivitaet(
            kanalName: Self.kurz(kanalName), communityName: Self.kurz(communityName))
        do {
            let a: Activity<SpracheAktivitaet>
            if #available(iOS 16.2, *) {
                a = try Activity.request(attributes: form, content: .init(state: stand, staleDate: nil))
            } else {
                a = try Activity.request(attributes: form, contentState: stand)
            }
            aktivitaet = a
            self.sitzung = sitzung
            gezeigt = stand
            zuletzt = Date()
            NSLog("[PulseAktivitaet] begonnen (Sitzung %ld): %@", sitzung, Self.beschreibung(stand))
        } catch {
            // Typisch: die App ist nicht im Vordergrund — ActivityKit lässt
            // Aktivitäten nur von dort beginnen.
            NSLog("[PulseAktivitaet] Beginnen fehlgeschlagen: %@", error.localizedDescription)
        }
    }

    private func anstossen(sofort: Bool) {
        guard aktivitaet != nil else { return }
        let warten = sofort ? 0 : Self.mindestAbstand - Date().timeIntervalSince(zuletzt)
        guard warten > 0 else {
            nachlauf?.cancel()
            nachlauf = nil
            aktualisieren()
            return
        }
        // Schon geplant: der Nachlauf liest beim Ausführen den DANN gültigen
        // Stand, ein zweiter brächte nichts.
        guard nachlauf == nil else { return }
        let arbeit = DispatchWorkItem { [weak self] in
            self?.nachlauf = nil
            self?.aktualisieren()
        }
        nachlauf = arbeit
        DispatchQueue.main.asyncAfter(deadline: .now() + warten, execute: arbeit)
    }

    private func aktualisieren() {
        guard let a = aktivitaet, let stand = standJetzt(), stand != gezeigt else { return }
        gezeigt = stand
        zuletzt = Date()
        nacheinander {
            if #available(iOS 16.2, *) {
                await a.update(.init(state: stand, staleDate: nil))
            } else {
                await a.update(using: stand)
            }
        }
    }

    private func beenden(sitzung: Int) {
        guard let a = aktivitaet, self.sitzung == sitzung else { return }
        vergessen()
        NSLog("[PulseAktivitaet] beendet (Sitzung %ld)", sitzung)
        nacheinander { await Self.schliessen(a) }
    }

    /// Auch Aktivitäten, die diese Instanz nicht kennt (früherer Lauf).
    func alleBeenden(_ grund: String) {
        let alle = Activity<SpracheAktivitaet>.activities
        vergessen()
        guard !alle.isEmpty else { return }
        NSLog("[PulseAktivitaet] %ld beendet (%@)", alle.count, grund)
        nacheinander {
            for a in alle { await Self.schliessen(a) }
        }
    }

    private func vergessen() {
        aktivitaet = nil
        sitzung = nil
        gezeigt = nil
        nachlauf?.cancel()
        nachlauf = nil
    }

    private func nacheinander(_ arbeit: @escaping () async -> Void) {
        let vorher = kette
        kette = Task {
            await vorher?.value
            await arbeit()
        }
    }

    /// Sofort weg statt der Vorgabe (bis zu vier Stunden auf dem
    /// Sperrbildschirm): ein verlassener Kanal ist keine Nachricht wert.
    private static func schliessen(_ a: Activity<SpracheAktivitaet>) async {
        if #available(iOS 16.2, *) {
            await a.end(nil, dismissalPolicy: .immediate)
        } else {
            await a.end(using: nil, dismissalPolicy: .immediate)
        }
    }

    // MARK: - Der Stand, am Raum gelesen

    private func standJetzt() -> SpracheAktivitaet.ContentState? {
        let sprache = SpracheRaum.geteilt
        guard let r = sprache.raum else { return nil }
        let ich = r.localParticipant
        let andere = Array(r.remoteParticipants.values)
        // Der Name nach derselben Regel wie in der Teilnehmerliste — `abbilden`
        // ist die eine Stelle dafür.
        let sprechend = andere.filter(\.isSpeaking)
            .map { Self.kurz(sprache.abbilden($0, lokal: false)["name"] as? String ?? "") }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        return SpracheAktivitaet.ContentState(
            teilnehmer: andere.count + 1,
            stumm: !ich.isMicrophoneEnabled(),
            taub: sprache.wirksamTaub,
            pausiert: sprache.anrufPausiert,
            gesperrt: SpracheStand.geteilt.erzwungen(fuer: ich).stumm,
            verbunden: r.connectionState == .connected,
            sprechend: Array(sprechend.prefix(2)),
            weitereSprechend: max(0, sprechend.count - 2))
    }

    /// ActivityKit nimmt höchstens 4 kB je Aktivität; ein Name, den jemand
    /// absichtlich lang macht, soll sie nicht sprengen.
    static func kurz(_ s: String) -> String {
        s.count > 40 ? String(s.prefix(39)) + "…" : s
    }

    static func beschreibung(_ s: SpracheAktivitaet.ContentState) -> String {
        "\(s.teilnehmer) im Kanal, stumm \(s.stumm), taub \(s.taub), pausiert \(s.pausiert), "
            + "gesperrt \(s.gesperrt), verbunden \(s.verbunden), sprechend \(s.sprechend.count + s.weitereSprechend)"
    }
}

// MARK: - Die Knöpfe der Aktivität

extension SpracheRaum {
    /// Ein Knopf der Live Activity (`SpracheMikrofonAbsicht`,
    /// `SpracheVerlassenAbsicht`), im Prozess der App ausgeführt.
    ///
    /// **Anders als die Knöpfe der Kanalansicht fragen sie das Web NICHT
    /// vorher** (`wunsch` in `SpracheSteuerleiste.swift`). Getippt wird auf dem
    /// Sperrbildschirm oder in der Dynamic Island — die Oberfläche ist dann in
    /// aller Regel eingefroren, ihre Hörer stehen aber noch. Ein Wunsch käme
    /// erst an, wenn die App wieder vorn ist: ein „stumm“, das minutenlang
    /// nicht wirkt, ist schlimmer als keiner. Die Regeln, die das Web sonst
    /// prüft, stehen deshalb hier noch einmal, soweit die Hülle sie kennt
    /// (`mikrofonDarfAn`); das Web erfährt den neuen Stand über die üblichen
    /// Meldungen und spiegelt ihn, sobald es läuft.
    func ausLiveAktivitaet(_ befehl: SpracheAktivitaetBefehl) async {
        guard raum != nil else {
            // Die Aktivität steht noch, der Raum nicht mehr — etwa nach einem
            // Absturz, wenn iOS die App nur für diesen Knopf gestartet hat.
            await MainActor.run { SpracheLiveAktivitaet.geteilt.alleBeenden("Knopf ohne Raum") }
            return
        }
        switch befehl {
        case .stumm(let stumm):
            await mikrofonAusAktivitaet(an: !stumm)
        case .verlassen:
            await verlassenAusAktivitaet()
        }
        SpracheLiveAktivitaet.anstossen(sofort: true)
    }

    private func mikrofonAusAktivitaet(an: Bool) async {
        if an, !(await mikrofonDarfAn()) {
            NSLog("[PulseAktivitaet] Mikrofon an abgelehnt (taub, Anruf oder Moderation)")
            return
        }
        do {
            try await nacheinander { try await self.mikrofon(an) }
        } catch {
            NSLog("[PulseAktivitaet] Mikrofon %@ fehlgeschlagen: %@",
                  an ? "an" : "aus", error.localizedDescription)
        }
    }

    /// Dieselben Riegel wie `toggleMic` im Web (`voice/livekit.svelte.ts`):
    /// nicht aus dem Taubstellen heraus, nicht gegen die Moderation — und
    /// nicht während eines Anrufs (dort gälte es ohnehin erst danach).
    /// Ausschalten ist immer erlaubt.
    private func mikrofonDarfAn() async -> Bool {
        guard !wirksamTaub, let ich = raum?.localParticipant else { return false }
        return await MainActor.run { !SpracheStand.geteilt.erzwungen(fuer: ich).stumm }
    }

    /// **Erst das Web bitten, dann sofort selbst gehen.** Das Web hat am
    /// Auflegen Pflichten, die die Hülle nicht kennt (Eintrag fürs
    /// Wiederaufnehmen löschen, eine gehostete Watch-Party beenden); es
    /// bekommt den Wunsch deshalb zuerst und arbeitet ihn ab, sobald es läuft.
    /// Die Reihenfolge der Meldungen ist dabei tragend: käme `disconnected`
    /// zuerst an, räumte das Web ab wie nach einem Netzabbruch und behielte
    /// den Eintrag — der nächste Reload träte wieder bei.
    private func verlassenAusAktivitaet() async {
        _ = wunschAnWeb?(.auflegen, true)
        await verlassen()
        melden("verbindung", ["zustand": "disconnected"])
    }
}
