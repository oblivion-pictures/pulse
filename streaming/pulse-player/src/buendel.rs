//! Buendel-Histogramm: wie lang sind die Verlust-Buendel auf der Leitung?
//!
//! **Wofuer.** Die FlexFEC-Paritaet loest je Gruppe genau EIN fehlendes Paket
//! (XOR, eine Unbekannte). Wie lang ein Buendel sein darf, damit es noch
//! reparierbar ist, entscheidet deshalb der Abstand der Pakete innerhalb einer
//! Gruppe (pion verteilt `X % numFecPackets`, s. `fec::gegenprobe`,
//! `mindestabstand`): bei zwei Paritaetspaketen je Gruppe ist ein Buendel aus
//! zwei Paketen noch zu retten, eines aus drei nicht mehr. Ob sich ein
//! groesserer Abstand lohnt, haengt an der Verteilung der Buendellaengen —
//! und die misst dieser Zaehler.
//!
//! **Gezaehlt wird der rohe Verlust bei der ERSTEN Ankunft**, also bevor
//! Nachlieferung (NACK) und Paritaet die Loecher stopfen. Genau das ist die
//! Groesse, gegen die die Paritaet antritt. `packets_lost` des Jitter-Puffers
//! misst etwas anderes: was NACH beiden Reparaturen noch fehlte. Deshalb
//! zaehlen wiederhergestellte Pakete (`RtpArrival::repariert`) hier nicht als
//! angekommen, und eine Nachlieferung nach Ablauf von [`UMSORTIER_FENSTER`]
//! aendert ein bereits gebuchtes Buendel nicht mehr.
//!
//! Reine Rechnung ohne Ein-/Ausgabe; die Sitzung fuettert, die App druckt.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// Wie lange ein Loch auf ein umsortiertes Paket wartet, bevor es als
/// Verlust gebucht wird.
///
/// **Warum 10 ms:** Eine Nachlieferung kann fruehestens eine Umlaufzeit nach
/// dem Verlust eintreffen (der Empfaenger muss das Loch erst bemerken, das
/// NACK muss hin, das Paket zurueck). Auf der Strecke, fuer die dieser Zaehler
/// gebaut wurde, lag die RTT am 2026-10-15 bei rund 37 ms (Angabe aus der
/// Messung, die ihn veranlasst hat; die tatsaechliche steht je Lauf in
/// `rtt_ms`). Was binnen 10 ms nachkommt, ist dort also echte Umsortierung im
/// Netz und kein nachgeliefertes Paket.
///
/// **Grenze:** Auf einer Strecke mit RTT unter 10 ms (LAN) kann auch eine
/// Nachlieferung im Fenster ankommen und wird dann als Umsortierung gelesen —
/// das Histogramm zeigt dort zu WENIG Verlust. Fuer kurze Strecken ist es
/// deshalb nur gegen `rtt_ms` gelesen aussagekraeftig.
pub const UMSORTIER_FENSTER: Duration = Duration::from_millis(10);

/// Vorlauf, um den das Abschliessen OHNE neues Paket ([`Buendelzaehler::stand`])
/// hinter der Uhr zurueckbleibt.
///
/// Der Grund ist die Reihenfolge in der Sitzung: zwischen Ankunft (Stempel in
/// `pump_track`) und Verarbeitung liegt der Kanal. Schloesse der Statistik-Takt
/// mit `Instant::now()` ab, koennte ein Paket, das laengst angekommen ist,
/// aber noch im Kanal steht, sein Loch nicht mehr fuellen und wuerde als
/// Verlust gebucht. Mit Paketen im Fluss schliesst ohnehin jede Ankunft ab
/// (nach IHREM Stempel); der Takt ist nur das Netz fuer den Fall, dass danach
/// nichts mehr kommt — dort sind 100 ms Verzug ohne Belang.
const TAKT_VORLAUF: Duration = Duration::from_millis(100);

/// Sprung, ab dem kein Buendel mehr gebucht, sondern neu angesetzt wird
/// (Neustart des Senders, neuer Strom). Dieselbe Grenze wie im Jitter-Puffer:
/// was der als Luecke behandelt, ist auch hier eine.
const NEUBEGINN_AB: i64 = crate::jitter::RESYNC_DISTANCE as i64;

/// Obergrenze offener Bereiche je Spur. Im Betrieb liegen binnen
/// [`UMSORTIER_FENSTER`] nur eine Handvoll offen; die Grenze greift erst bei
/// einem Strom, der dauernd springt, und haelt dann den Speicher fest.
const HOECHSTENS_OFFEN: usize = 1024;

/// Beschriftung der Eimer, in der Reihenfolge von [`Buendelstand::eimer`].
const EIMER: [&str; 9] = ["1", "2", "3", "4", "5", "6-10", "11-20", "21-50", ">50"];

/// Kumulierter Stand je Spur und Sitzung. `Copy`, weil er in
/// `SessionStats` mitreist.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Buendelstand {
    /// Zahl der Buendel je Laengen-Eimer (Beschriftung: [`EIMER`]).
    pub eimer: [u64; 9],
    /// Verlorene Pakete bei erster Ankunft, Summe aller Buendellaengen.
    pub verloren: u64,
    pub buendel: u64,
    /// Wie oft wegen Kennungswechsel oder Riesensprung neu angesetzt wurde.
    /// Offene Loecher fallen dabei weg — ungezaehlt, s. [`Buendelzaehler`].
    pub neubeginne: u64,
}

fn eimer_fuer(laenge: u64) -> usize {
    match laenge {
        0..=5 => laenge.saturating_sub(1) as usize,
        6..=10 => 5,
        11..=20 => 6,
        21..=50 => 7,
        _ => 8,
    }
}

impl Buendelstand {
    fn buchen(&mut self, laenge: u64) {
        self.eimer[eimer_fuer(laenge)] += 1;
        self.verloren += laenge;
        self.buendel += 1;
    }

    /// `1:812 2:240 … >50:0 (verloren 1503)` — kompakt, weil die Zeile in den
    /// Diagnose-Upload geht, der nur die letzten 512 KB traegt.
    pub fn zeile(&self) -> String {
        let eimer: Vec<String> =
            EIMER.iter().zip(self.eimer).map(|(n, z)| format!("{n}:{z}")).collect();
        let neu = match self.neubeginne {
            0 => String::new(),
            n => format!(", Neubeginn {n}"),
        };
        format!("{} (verloren {}{neu})", eimer.join(" "), self.verloren)
    }
}

/// Zaehlt die Buendel EINER Spur (eigene Sequenznummern je Spur).
///
/// Offene Loecher stehen als BEREICHE nach Anfangsnummer sortiert und tragen
/// den Zeitpunkt, zu dem sie aufgerissen sind. Neue Loecher entstehen nur
/// oberhalb der hoechsten Nummer und damit nie frueher als die vorhandenen —
/// der vorderste Bereich ist also immer der aelteste, und das Abschliessen
/// arbeitet von vorn. Ein Bereich ist beim Abschliessen genau ein Buendel:
/// zwei Bereiche grenzen nie aneinander, zwischen ihnen liegt immer ein
/// angekommenes Paket.
///
/// **Bereiche statt Einzelnummern** (Sicherheitspruefung 2026-10-15): je
/// Nummer ein Eintrag hiesse, dass ein Sender, der mit jedem Paket knapp
/// unter [`NEUBEGINN_AB`] springt, je Paket rund 3000 Eintraege erzwingt —
/// Rechenlast im selben Task, der auch dekodiert. Als Bereich kostet jedes
/// Paket hoechstens eine Suche und zwei Eintraege; [`HOECHSTENS_OFFEN`]
/// deckelt zusaetzlich den Speicher.
///
/// Bei einem Neuansatz (andere SSRC, Sprung um mehr als [`NEUBEGINN_AB`])
/// werden offene Loecher verworfen statt gebucht: ob sie noch kommen, ist ab
/// da nicht mehr zu beobachten. Ein Neustart, der weniger als
/// [`NEUBEGINN_AB`] RUECKWAERTS landet, wird nicht erkannt; seine Pakete
/// gelten als alt, bis die Zaehlung die alte Hoechstmarke ueberholt.
#[derive(Debug, Default)]
pub struct Buendelzaehler {
    ssrc: Option<u32>,
    /// Hoechste gesehene Nummer, erweitert ueber den 16-bit-Ueberlauf. Beginnt
    /// bei `1 << 16 | seq`, damit ein Nachzuegler kurz nach dem Start nicht
    /// unter null rechnet.
    hoechste: Option<u64>,
    /// Anfang → (Ende exklusiv, aufgerissen um).
    offen: BTreeMap<u64, (u64, Instant)>,
    stand: Buendelstand,
}

impl Buendelzaehler {
    /// Ein Paket bei seiner ersten Ankunft. Wiederhergestellte Pakete gehoeren
    /// NICHT hierher (s. Modul-Doku).
    pub fn einspeisen(&mut self, ssrc: u32, seq: u16, jetzt: Instant) {
        self.abschliessen(jetzt);
        let hoechste = match self.hoechste {
            Some(h) if self.ssrc == Some(ssrc) => h,
            vorher => {
                self.neu_ansetzen(ssrc, seq, vorher.is_some());
                return;
            }
        };
        // Vorzeichenbehafteter Abstand zur Hoechstmarke ueber den Ueberlauf
        // hinweg: 65535 → 0 ist +1, 0 → 65535 ist -1.
        let abstand = i64::from(seq.wrapping_sub(hoechste as u16) as i16);
        if abstand.abs() > NEUBEGINN_AB {
            self.neu_ansetzen(ssrc, seq, true);
            return;
        }
        let erweitert = hoechste.wrapping_add_signed(abstand);
        if abstand <= 0 {
            // Fuellt es ein offenes Loch, war es Umsortierung; sonst ist es
            // eine Dopplung oder eine Nachlieferung fuer ein gebuchtes Loch.
            self.fuellen(erweitert);
            return;
        }
        if erweitert > hoechste + 1 {
            self.offen.insert(hoechste + 1, (erweitert, jetzt));
            if self.offen.len() > HOECHSTENS_OFFEN {
                // Vorzeitig buchen statt unbegrenzt wachsen: der aelteste
                // Bereich verliert nur seine restliche Wartezeit.
                if let Some((anfang, (ende, _))) = self.offen.pop_first() {
                    self.stand.buchen(ende - anfang);
                }
            }
        }
        self.hoechste = Some(erweitert);
    }

    /// Bucht faellige Loecher auch ohne neues Paket und gibt den Stand
    /// zurueck. Fuer den Statistik-Takt (Begruendung des Abstands:
    /// [`TAKT_VORLAUF`]).
    pub fn stand(&mut self, jetzt: Instant) -> Buendelstand {
        if let Some(bis) = jetzt.checked_sub(TAKT_VORLAUF) {
            self.abschliessen(bis);
        }
        self.stand
    }

    fn neu_ansetzen(&mut self, ssrc: u32, seq: u16, war_schon_da: bool) {
        self.stand.neubeginne += u64::from(war_schon_da);
        self.offen.clear();
        self.ssrc = Some(ssrc);
        self.hoechste = Some((1 << 16) | u64::from(seq));
    }

    /// Nimmt eine angekommene Nummer aus ihrem offenen Bereich; der Rest
    /// zerfaellt in bis zu zwei Bereiche mit demselben Zeitstempel.
    fn fuellen(&mut self, seq: u64) {
        let Some((&anfang, &(ende, seit))) = self.offen.range(..=seq).next_back() else {
            return;
        };
        if seq >= ende {
            return;
        }
        self.offen.remove(&anfang);
        if anfang < seq {
            self.offen.insert(anfang, (seq, seit));
        }
        if seq + 1 < ende {
            self.offen.insert(seq + 1, (ende, seit));
        }
    }

    /// Bucht alle Bereiche, deren Fenster abgelaufen ist — jeder als ein
    /// Buendel (s. Typ-Doku, warum zwei Bereiche nie zusammengehoeren).
    fn abschliessen(&mut self, jetzt: Instant) {
        while let Some((_, &(_, seit))) = self.offen.first_key_value() {
            if seit + UMSORTIER_FENSTER > jetzt {
                break;
            }
            if let Some((anfang, (ende, _))) = self.offen.pop_first() {
                self.stand.buchen(ende - anfang);
            }
        }
    }
}

/// Mindestabstand zweier Buendel-Zeilen derselben Sitzung.
const MELDEABSTAND: Duration = Duration::from_secs(10);

/// Entscheidet, wann die Buendel-Zeile einer Sitzung gedruckt wird:
/// hoechstens alle [`MELDEABSTAND`] und nur bei veraendertem Stand. Zum
/// Schluss einmal, wenn sich seit der letzten Zeile etwas getan hat — oder
/// wenn es noch keine gab, damit „kein Buendel" von „nicht gemessen" zu
/// unterscheiden ist.
#[derive(Debug, Default)]
pub struct Meldetakt {
    zuletzt: Option<Instant>,
    gemeldet: (Buendelstand, Buendelstand),
}

impl Meldetakt {
    pub fn melden(
        &mut self,
        jetzt: Instant,
        bild: Buendelstand,
        ton: Buendelstand,
        zum_schluss: bool,
    ) -> Option<String> {
        let geaendert = (bild, ton) != self.gemeldet;
        let faellig = if zum_schluss {
            geaendert || self.zuletzt.is_none()
        } else {
            geaendert && self.zuletzt.is_none_or(|t| jetzt.duration_since(t) >= MELDEABSTAND)
        };
        if !faellig {
            return None;
        }
        self.zuletzt = Some(jetzt);
        self.gemeldet = (bild, ton);
        Some(format!("Buendel Bild — {}; Ton — {}", bild.zeile(), ton.zeile()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SSRC: u32 = 7;

    fn ms(t0: Instant, n: u64) -> Instant {
        t0 + Duration::from_millis(n)
    }

    /// Speist die Nummern alle zum Zeitpunkt `t0` ein und schliesst danach
    /// mit abgelaufenem Fenster ab.
    fn lauf(seqs: &[u16]) -> Buendelstand {
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        for &s in seqs {
            z.einspeisen(SSRC, s, t0);
        }
        z.stand(ms(t0, 1000))
    }

    fn eimer(paare: &[(usize, u64)]) -> [u64; 9] {
        let mut e = [0; 9];
        for &(i, n) in paare {
            e[i] = n;
        }
        e
    }

    #[test]
    fn einzelverlust() {
        let st = lauf(&[1, 2, 4, 5]);
        assert_eq!(st.eimer, eimer(&[(0, 1)]));
        assert_eq!((st.verloren, st.buendel), (1, 1));
    }

    #[test]
    fn buendel_aus_drei() {
        let st = lauf(&[10, 14, 15]);
        assert_eq!(st.eimer, eimer(&[(2, 1)]));
        assert_eq!(st.verloren, 3);
    }

    #[test]
    fn zwei_getrennte_buendel() {
        let st = lauf(&[1, 3, 4, 8, 9]);
        assert_eq!(st.eimer, eimer(&[(0, 1), (2, 1)]));
        assert_eq!((st.verloren, st.buendel), (4, 2));
    }

    #[test]
    fn umsortierung_im_fenster_ist_kein_verlust() {
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        z.einspeisen(SSRC, 1, t0);
        z.einspeisen(SSRC, 3, t0);
        z.einspeisen(SSRC, 2, ms(t0, 5));
        assert_eq!(z.stand(ms(t0, 1000)), Buendelstand::default());
    }

    #[test]
    fn umsortiertes_paket_teilt_ein_loch() {
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        z.einspeisen(SSRC, 1, t0);
        z.einspeisen(SSRC, 5, t0);
        z.einspeisen(SSRC, 3, ms(t0, 5));
        let st = z.stand(ms(t0, 1000));
        assert_eq!(st.eimer, eimer(&[(0, 2)]));
    }

    #[test]
    fn fuellen_an_den_raendern_eines_lochs() {
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        z.einspeisen(SSRC, 1, t0);
        z.einspeisen(SSRC, 7, t0); // Loch 2..=6
        z.einspeisen(SSRC, 2, ms(t0, 2));
        z.einspeisen(SSRC, 6, ms(t0, 2));
        let st = z.stand(ms(t0, 1000));
        assert_eq!(st.eimer, eimer(&[(2, 1)])); // 3, 4, 5
    }

    /// Sicherheitspruefung 2026-10-15: ein Strom, der mit jedem Paket knapp
    /// unter die Neuansatz-Grenze springt, darf weder je Paket Tausende
    /// Eintraege erzeugen noch den Speicher unbegrenzt fuellen.
    #[test]
    fn dauerspringer_bleibt_gedeckelt() {
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        let sprung = (NEUBEGINN_AB - 1) as u16;
        let mut seq = 0u16;
        for _ in 0..5000 {
            z.einspeisen(SSRC, seq, t0);
            seq = seq.wrapping_add(sprung);
        }
        assert!(z.offen.len() <= HOECHSTENS_OFFEN);
        let st = z.stand(ms(t0, 1000));
        assert_eq!(st.buendel, 4999);
        assert_eq!(st.verloren, 4999 * (u64::from(sprung) - 1));
        assert_eq!(st.neubeginne, 0);
    }

    #[test]
    fn nachlieferung_nach_fenster_bleibt_verlust() {
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        z.einspeisen(SSRC, 1, t0);
        z.einspeisen(SSRC, 4, t0);
        // Wie eine NACK-Nachlieferung eine Umlaufzeit spaeter.
        z.einspeisen(SSRC, 2, ms(t0, 37));
        z.einspeisen(SSRC, 3, ms(t0, 38));
        let st = z.stand(ms(t0, 1000));
        assert_eq!(st.eimer, eimer(&[(1, 1)]));
        assert_eq!(st.verloren, 2);
    }

    #[test]
    fn faellige_loecher_ohne_weiteres_paket() {
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        z.einspeisen(SSRC, 1, t0);
        z.einspeisen(SSRC, 3, t0);
        // Fenster abgelaufen, aber noch im Vorlauf des Takts: noch nichts.
        assert_eq!(z.stand(ms(t0, 50)).buendel, 0);
        assert_eq!(z.stand(ms(t0, 111)).buendel, 1);
    }

    #[test]
    fn ueberlauf_65535_auf_0() {
        assert_eq!(lauf(&[65534, 65535, 1]).eimer, eimer(&[(0, 1)]));
        // Buendel ueber die Grenze hinweg: 65534, 65535, 0, 1 fehlen.
        let st = lauf(&[65533, 2]);
        assert_eq!(st.eimer, eimer(&[(3, 1)]));
        // Nachzuegler von vor dem Ueberlauf fuellt sein Loch.
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        z.einspeisen(SSRC, 65534, t0);
        z.einspeisen(SSRC, 0, t0);
        z.einspeisen(SSRC, 65535, ms(t0, 2));
        assert_eq!(z.stand(ms(t0, 1000)), Buendelstand::default());
    }

    #[test]
    fn dopplungen_und_alte_pakete_zaehlen_nicht() {
        assert_eq!(lauf(&[1, 2, 2, 3, 1, 3]), Buendelstand::default());
    }

    #[test]
    fn riesensprung_setzt_neu_an() {
        let st = lauf(&[1, 2, 5000, 5001, 5003]);
        assert_eq!(st.eimer, eimer(&[(0, 1)]));
        assert_eq!((st.verloren, st.neubeginne), (1, 1));
        // Rueckwaerts ebenso.
        let st = lauf(&[40000, 30000, 30001]);
        assert_eq!((st.buendel, st.neubeginne), (0, 1));
    }

    #[test]
    fn neue_ssrc_setzt_neu_an_und_verwirft_offene_loecher() {
        let t0 = Instant::now();
        let mut z = Buendelzaehler::default();
        z.einspeisen(SSRC, 1, t0);
        z.einspeisen(SSRC, 5, t0);
        z.einspeisen(SSRC + 1, 6, t0);
        let st = z.stand(ms(t0, 1000));
        assert_eq!((st.buendel, st.neubeginne), (0, 1));
    }

    #[test]
    fn eimergrenzen() {
        let grenzen =
            [(1, 0), (5, 4), (6, 5), (10, 5), (11, 6), (20, 6), (21, 7), (50, 7), (51, 8)];
        for (laenge, i) in grenzen {
            assert_eq!(eimer_fuer(laenge), i, "Laenge {laenge}");
        }
        // Und ueber den ganzen Weg: 50 und 51 fehlende Pakete.
        assert_eq!(lauf(&[0, 51]).eimer, eimer(&[(7, 1)]));
        assert_eq!(lauf(&[0, 52]).eimer, eimer(&[(8, 1)]));
    }

    #[test]
    fn zeile_ist_kompakt() {
        let mut st = Buendelstand::default();
        st.buchen(1);
        st.buchen(1);
        st.buchen(7);
        assert_eq!(st.zeile(), "1:2 2:0 3:0 4:0 5:0 6-10:1 11-20:0 21-50:0 >50:0 (verloren 9)");
        st.neubeginne = 2;
        assert!(st.zeile().ends_with("(verloren 9, Neubeginn 2)"));
    }

    #[test]
    fn meldetakt_nur_bei_aenderung_und_hoechstens_alle_10_s() {
        let t0 = Instant::now();
        let mut m = Meldetakt::default();
        let leer = Buendelstand::default();
        let mut eins = leer;
        eins.buchen(1);
        let mut zwei = eins;
        zwei.buchen(3);

        assert!(m.melden(t0, leer, leer, false).is_none(), "nichts passiert");
        let z = m.melden(t0, eins, leer, false).expect("erste Aenderung sofort");
        assert!(z.starts_with("Buendel Bild — 1:1 ") && z.contains("; Ton — 1:0 "));
        assert!(m.melden(ms(t0, 5000), zwei, leer, false).is_none(), "zu frueh");
        assert!(m.melden(ms(t0, 10_000), zwei, leer, false).is_some());
        assert!(m.melden(ms(t0, 30_000), zwei, leer, false).is_none(), "unveraendert");
        assert!(m.melden(ms(t0, 31_000), zwei, leer, true).is_none(), "Schluss ohne Neues");
        assert!(m.melden(ms(t0, 31_000), zwei, eins, true).is_some(), "Schluss mit Neuem");

        let mut frisch = Meldetakt::default();
        assert!(frisch.melden(t0, leer, leer, true).is_some(), "Schluss ohne je eine Zeile");
    }
}
