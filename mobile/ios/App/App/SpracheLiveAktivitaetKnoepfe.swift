import Foundation

// Eigene Datei seit dem 2026-10-11 (Grössen-Policy, `PLAN.md` §12.1): stand
// bis dahin am Ende von `SpracheLiveAktivitaet.swift`, unverändert.

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
    /// den Eintrag — der nächste Reload träte wieder bei. Hört das Web gar
    /// nicht zu (WebContent abgestürzt), merkt sich die Hülle das Auflegen
    /// selbst (`vomNutzerAufgelegt`, B1).
    private func verlassenAusAktivitaet() async {
        _ = await wunschAnWeb?(.auflegen, true)
        await vomNutzerAufgelegt()
        melden("verbindung", ["zustand": "disconnected"])
    }
}
