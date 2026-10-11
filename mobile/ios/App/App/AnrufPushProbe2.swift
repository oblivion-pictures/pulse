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
            // R1: ein klingelnder Anruf DESSELBEN Kanals gilt als abgelöst.
            let alt = UUID()
            soll("R1: ein Rückruf desselben Kanals löst den klingelnden ab",
                 V.pushAusgang(art: .klingeln, bekannt: nil, klingelt: false, kuerzlichBeendet: false,
                               ohneCallKit: false, abgeloest: alt) == .abloesen(alt))
            soll("R1: läuft daneben noch ein anderer, bleibt es besetzt (A5)",
                 V.pushAusgang(art: .klingeln, bekannt: nil, klingelt: false, kuerzlichBeendet: false,
                               ohneCallKit: false, besetzt: true, abgeloest: alt) == .besetzt)
            soll("R1: ein eben beendeter löst nichts ab",
                 V.pushAusgang(art: .klingeln, bekannt: nil, klingelt: false, kuerzlichBeendet: true,
                               ohneCallKit: false, abgeloest: alt) == .meldenUndSofortBeenden)
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

        private static func klingeln(_ kennung: String, kanal: String) -> [String: String] {
            ["art": "klingelt", "call_id": kennung, "einleiter_name": "Probe",
             "anruf_art": "dm", "channel_id": kanal]
        }

        /// **R1 gegen CallKit**: ein Rückruf desselben Kanals, während der
        /// frühere noch klingelt — im selben Lauf, weil der Simulator jeden
        /// Anruf nach rund 150 ms trennt (Kopf von `AnrufPushProbe`). Danach
        /// ein Anruf aus einem ANDEREN Kanal: der bleibt besetzt (A5).
        @MainActor static func abloesung(_ stamm: String) async {
            let v = V.geteilt
            // CallKit führt höchstens eine Anrufgruppe; die Anrufe davor
            // müssen dort erst zu Ende sein (s. `laufendesGespraechVersuch`).
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            let alt = stamm + "-alt", neu = stamm + "-neu", fremd = stamm + "-fremd"
            var altUuid: UUID?
            await AnrufPushProbe.zustellen([
                .init(was: "R1: ein Anruf klingelt", inhalt: klingeln(alt, kanal: "r1"), ausgang: .neuMelden),
                .init(was: "R1: Rückruf desselben Kanals, der frühere klingelt noch",
                      inhalt: klingeln(neu, kanal: "r1"),
                      ausgangDanach: { altUuid.map { .abloesen($0) } },
                      vorher: { altUuid = v.uuid(fuer: alt) },
                      // Der Beleg, dass CallKit den neuen gleich nach dem Ende
                      // des alten annimmt (eine Anrufgruppe, `starten()`).
                      folge: .angezeigt,
                      stand: ("der frühere ist beendet, der neue klingelt", {
                          v.uuid(fuer: alt) == nil && v.kuerzlichBeendet[alt] != nil
                              && v.uuid(fuer: neu).map { v.phasen[$0] == .klingelt } == true
                      })),
                .init(was: "R1/A5: ein Anruf aus einem anderen Kanal bleibt besetzt",
                      inhalt: klingeln(fremd, kanal: "r1-anders"), ausgang: .besetzt,
                      stand: ("abgewiesen, der neue klingelt weiter", {
                          v.uuid(fuer: fremd) == nil && v.uuid(fuer: neu) != nil
                      })),
            ])
            soll("R1: der frühere war gebucht, als der Rückruf kam", altUuid != nil)
            v.beenden(kennung: neu, grund: .lokal)
        }
    }
#endif
