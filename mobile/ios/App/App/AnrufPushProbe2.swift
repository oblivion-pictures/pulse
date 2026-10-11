import Foundation

#if DEBUG
    /// **Bughunt 2 vom 2026-10-11 im Prüfpfad der Push-Ausgänge** — läuft mit
    /// `AnrufPushProbe` (`-PulseAnrufPushProbe 1`), eigene Datei wegen der
    /// Grössen-Policy. Die Abläufe gegen CallKit für A3 und A5 stehen dort in
    /// `laufendesGespraechVersuch`, weil sie ein laufendes Gespräch brauchen.
    enum AnrufPushProbe2 {
        private typealias V = Anrufverwaltung

        /// Dieselbe Log-Zeile und dieselbe Fehlerzahl wie `AnrufPushProbe`.
        @MainActor private static func soll(_ was: String, _ ist: Bool) {
            AnrufPushProbe.soll(was, ist)
        }

        /// Die Entscheidungstabelle für A3, A5 und A6, ohne CallKit.
        @MainActor static func tabelle() {
            let u = UUID()
            func ausgang(_ art: V.PushArt, _ bekannt: UUID?, klingelt: Bool = false,
                         kuerzlich: Bool = false, ohneRaum: Bool = false, besetzt: Bool = false) -> V.PushAusgang {
                V.pushAusgang(art: art, bekannt: bekannt, klingelt: klingelt, kuerzlichBeendet: kuerzlich,
                              ohneCallKit: false, angenommenOhneRaum: ohneRaum, besetzt: besetzt)
            }
            soll("A3: Abbruch für einen angenommenen Anruf ohne Raum → erneut melden und beenden",
                 ausgang(.abbruch, u, ohneRaum: true) == .erneutMeldenUndBeenden(u))
            soll("A3: Abbruch für ein Gespräch mit Raum → nur erneut melden",
                 ausgang(.abbruch, u) == .erneutMelden(u))
            soll("A3: Klingeln für einen angenommenen Anruf ohne Raum → nur erneut melden",
                 ausgang(.klingeln, u, ohneRaum: true) == .erneutMelden(u))
            soll("A3: nach der Meldung beendet ein Abbruch das Angenommene nur ohne Raum",
                 V.nachErneuterMeldung(.schonBekannt, beenden: true, phase: .angenommen, raumBegonnen: false)
                     == .beenden
                     && V.nachErneuterMeldung(.schonBekannt, beenden: true, phase: .angenommen,
                                              raumBegonnen: true) == .nichts)
            soll("A5: ein neuer Anruf, während ein anderer läuft → besetzt",
                 ausgang(.klingeln, nil, besetzt: true) == .besetzt)
            soll("A5: ein eben beendeter bleibt beendet, auch besetzt",
                 ausgang(.klingeln, nil, kuerzlich: true, besetzt: true) == .meldenUndSofortBeenden)
            soll("A5: ein Abbruch während eines anderen Anrufs → melden und sofort beenden",
                 ausgang(.abbruch, nil, besetzt: true) == .meldenUndSofortBeenden)
            soll("A5: der laufende Anruf selbst ist nicht besetzt",
                 ausgang(.klingeln, u, besetzt: true) == .erneutMelden(u))
            // **A6, die Entscheidung:** die Hülle hält keinen CallKit-Eintrag
            // nach dem WS-Ende offen. Ein Abbruch, der danach kommt, wird
            // weiter gemeldet und sofort beendet — gespart wird er am Server,
            // der ihn einem Gerät, das das Ende quittiert hat, gar nicht
            // erst schickt (`anruf_push.py`, `ende_gesehen`).
            soll("A6: Abbruch nach dem WS-Ende → melden und sofort beenden (Apples Regel, gespart wird am Server)",
                 ausgang(.abbruch, nil, kuerzlich: true) == .meldenUndSofortBeenden)
        }

        /// A4: die Oberfläche nimmt einen Anruf an, dessen Ende sie überholt
        /// hat — CallKit bekommt KEIN Gespräch dafür.
        @MainActor static func annahmeNachDemEnde(_ k: String) async {
            let v = V.geteilt
            guard v.istKuerzlichBeendet(k) else {
                soll("A4: Anruf als kürzlich beendet gemerkt — sonst nicht prüfbar", false)
                return
            }
            await withCheckedContinuation { (weiter: CheckedContinuation<Void, Never>) in
                v.annehmenVomWeb(kennung: k, name: "Probe") { weiter.resume() }
            }
            soll("A4: Annahme nach dem Ende beginnt kein Gespräch", v.uuid(fuer: k) == nil && !v.fuehrt(k))
        }
    }
#endif
