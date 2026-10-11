import ActivityKit
import Foundation

#if DEBUG
    /// **Prüfpfad für die Live Activity „Im Sprachkanal“ — nur in Debug-Bauten**
    /// (Muster: `WiedergabebegrenzerProbe.swift`).
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app \
    ///         -PulseAktivitaetProbe "<wsUrl>|<token>|<sekunden>[|bleiben]"
    ///
    /// Tritt einem Raum des lokalen LiveKit bei, wie es die Oberfläche täte
    /// (`SpracheRaum.beitreten`, mit Kanal- und Community-Namen), und prüft:
    /// die Aktivität beginnt mit dem Raum, sie folgt ihm `sekunden` lang (ein
    /// zweiter Teilnehmer mit Ton zeigt die Sprechanzeige), die Knöpfe gehen
    /// über GENAU den Weg, den iOS für sie nimmt (`SpracheAktivitaetSteuerung`
    /// — dieselbe Stelle, die `perform` der Absichten ruft), und mit dem Raum
    /// endet die Aktivität. `bleiben` lässt den Raum stehen — für den Blick
    /// auf Sperrbildschirm und Dynamic Island und den echten Knopfdruck dort.
    enum SpracheLiveAktivitaetProbe {
        static func ausStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseAktivitaetProbe") else { return }
            let teile = roh.split(separator: "|", maxSplits: 3).map(String.init)
            guard teile.count >= 2 else {
                NSLog("[PulseAktivitaet] Probe: erwartet \"<wsUrl>|<token>[|<sekunden>[|bleiben]]\"")
                return
            }
            let sekunden = teile.count > 2 ? (Int(teile[2]) ?? 10) : 10
            let bleiben = teile.count > 3 && teile[3] == "bleiben"
            Task { await fahren(wsUrl: teile[0], token: teile[1], sekunden: sekunden, bleiben: bleiben) }
        }

        private static func soll(_ was: String, _ ist: Bool) {
            NSLog("[PulseAktivitaet] Probe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        private static func warten(_ s: Double) async {
            try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
        }

        private static func fahren(wsUrl: String, token: String, sekunden: Int, bleiben: Bool) async {
            // Die Oberfläche lädt im Hintergrund; ihr Start räumt nichts ab,
            // aber ein früher Beitritt käme vor `einrichten` — kurz warten.
            await warten(2)
            let raum = SpracheRaum.geteilt
            do {
                try await raum.beitreten(
                    wsUrl: wsUrl, token: token, kanalId: "probe", kanalName: "Probe-Kanal",
                    communityName: "Probe-Community", stumm: true, taubStart: false)
            } catch {
                soll("Beitritt (\(error.localizedDescription))", false)
                return
            }
            await warten(1)
            let aktiv = Activity<SpracheAktivitaet>.activities
            soll("genau eine Aktivität nach dem Beitritt (\(aktiv.count))", aktiv.count == 1)
            if let a = aktiv.first {
                soll("Kanal und Community in der Form",
                     a.attributes.kanalName == "Probe-Kanal" && a.attributes.communityName == "Probe-Community")
            }
            berichten("nach Beitritt")

            for runde in 1 ... max(1, sekunden / 2) {
                await warten(2)
                berichten("Runde \(runde)")
            }

            await SpracheAktivitaetSteuerung.weiterreichen(.stumm(false))
            await warten(0.5)
            berichten("nach Knopf Mikrofon an (im Simulator ohne Mikrofon: bleibt stumm)")
            await SpracheAktivitaetSteuerung.weiterreichen(.stumm(true))
            await warten(0.5)
            berichten("nach Knopf stumm")
            soll("stumm nach Knopf stumm", zustand()?.stumm == true)

            if bleiben {
                NSLog("[PulseAktivitaet] Probe: Raum bleibt stehen (bleiben)")
                return
            }
            await SpracheAktivitaetSteuerung.weiterreichen(.verlassen)
            await warten(1.5)
            soll("Raum nach Knopf Verlassen weg", raum.raum == nil)
            let rest = Activity<SpracheAktivitaet>.activities.filter { $0.activityState == .active }
            soll("keine aktive Aktivität nach Knopf Verlassen (\(rest.count))", rest.isEmpty)
        }

        private static func zustand() -> SpracheAktivitaet.ContentState? {
            guard let a = Activity<SpracheAktivitaet>.activities.first else { return nil }
            if #available(iOS 16.2, *) { return a.content.state }
            return a.contentState
        }

        private static func berichten(_ wann: String) {
            guard let s = zustand() else {
                NSLog("[PulseAktivitaet] Probe %@: keine Aktivität", wann)
                return
            }
            // Die Namen nur hier, im Prüfpfad: im Betrieb gehören sie nicht ins Log.
            NSLog("[PulseAktivitaet] Probe %@: %@ [%@]", wann, SpracheLiveAktivitaet.beschreibung(s),
                  s.sprechend.joined(separator: ", "))
        }
    }
#endif
