//! Zaehlzeilen fuer Bild und Ton — **ohne** `PULSE_PLAYER_STATS_LOG`.
//!
//! **Warum es das gibt (2026-10-21).** Bei einer Fernsteuerung klang der Ton
//! zeitweise blechern und das Bild ruckte. Die Zahlen, die das erklaert
//! haetten, lagen im Player vor (`MediaStats`, der Ausgabe-Takt, die
//! Sitzung), gingen aber nur mit `PULSE_PLAYER_STATS_LOG` ins Log — und den
//! setzt die Desktop-App nur, solange die Diagnose-Uebermittlung an ist. Auf
//! dem Rechner des Eigentuemers war sie aus, die Zeilen fehlten. Ausserdem
//! fehlte in jedem Fall, wie LANG die Tonluecken waren; daran haengt, wie
//! viele Kopien eine Ton-Reserve (RED) auf der Senderstrecke tragen muesste
//! (Entwurf `intern/docs/superpowers/specs/2026-10-21-ton-reserve-design.md`,
//! Teil A).
//!
//! **Wie oft.** Hoechstens eine Zeile je Art und Minute, und nur, wenn seit
//! der letzten etwas war; dazu IMMER eine zum Sitzungsende, auch mit „nichts
//! gefehlt" — sonst ist eine saubere Sitzung nicht von einer ungezaehlten zu
//! unterscheiden. Bei 60 Minuten Fernsteuerung mit dauernder Stoerung sind das
//! rund 120 Zeilen, gegen 3600 je Stunde mit dem Pruefschalter.
//!
//! **Was die Zahlen sind.** Die Minutenzeilen nennen, was SEIT DER LETZTEN
//! ZEILE dazukam, mit der Fensterlaenge in Klammern — genau wie die Zeile
//! „Strecke zum Server" des Senders (`pulse-whip/src/strecke.rs`), gegen die
//! sie gelesen werden. Die Schlusszeile nennt die ganze Sitzung. Der Ton zaehlt
//! den **Gesamtrest beim Zuschauer** (beide Strecken zusammen); welche Strecke
//! es war, ergibt erst der Abgleich mit dem Sender, der Player kann es nicht
//! unterscheiden.
//!
//! Reine Rechnung ohne Ein-/Ausgabe; die App sammelt die Staende ein und druckt
//! (`app::minutenzeile`). Keine Kennungen, Adressen oder Schluessel — nur
//! Zaehler.

use std::time::{Duration, Instant};

/// Hoechstens eine Minutenzeile je Art in diesem Abstand.
const MELDEABSTAND: Duration = Duration::from_secs(60);

/// Beschriftung der Stufen von [`Lueckenstufen`].
///
/// **Warum diese Stufen** (Entwurf, Teil A): daran liest man die Kopienzahl
/// fuer eine Ton-Reserve ab. 1 Kopie rettet Einzelverluste, 2 auch doppelte,
/// 3 dreifache; ab 4 hilft laut Entwurf keine Kopienzahl mehr, weil der
/// Server beim Ton nur 4 Pakete wartet (`PULSE_AUDIO_REORDER_BUFFER`). 10+
/// trennt kurze Aussetzer von Abrissen.
const STUFEN: [&str; 5] = ["1", "2", "3", "4-9", "10+"];

/// Laengen der Tonluecken, wie der Jitter-Puffer sie aufgibt — also NACH der
/// Nachforderung. Eine Luecke ist eine Folge fehlender Pakete am Stueck
/// (`Release::Gap { missing }`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Lueckenstufen {
    pub stufen: [u64; 5],
}

impl Lueckenstufen {
    /// Eine aufgegebene Luecke von `pakete` fehlenden Paketen buchen.
    pub fn buchen(&mut self, pakete: u64) {
        let stufe = match pakete {
            0 => return,
            1 => 0,
            2 => 1,
            3 => 2,
            4..=9 => 3,
            _ => 4,
        };
        self.stufen[stufe] += 1;
    }

    fn seit(&self, alt: &Self) -> Self {
        Self { stufen: std::array::from_fn(|i| self.stufen[i].saturating_sub(alt.stufen[i])) }
    }

    /// `1:8 2:2 3:0 4-9:0 10+:0`
    fn text(&self) -> String {
        STUFEN.iter().zip(self.stufen).map(|(n, z)| format!("{n}:{z}")).collect::<Vec<_>>().join(" ")
    }
}

/// Was eine Zaehlzeile kann: aus zwei kumulierten Staenden den Zuwachs
/// bilden, sagen ob etwas war, und sich beschreiben.
pub trait Stand: Copy + Default {
    /// Zeilenanfang, z. B. „Ton-Zaehlung".
    const NAME: &'static str;
    fn seit(&self, alt: &Self) -> Self;
    /// Nichts passiert? Dann gibt es keine Minutenzeile.
    fn leer(&self) -> bool;
    fn text(&self) -> String;
    /// Text der Schlusszeile einer Sitzung ohne jedes Ereignis.
    fn nichts(&self) -> String;
}

/// Ton, kumuliert je Sitzung.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Tonstand {
    /// Verlorene Tonpakete laut Jitter-Puffer, nach der Nachforderung.
    pub verloren: u64,
    pub luecken: Lueckenstufen,
    /// Bei der ERSTEN Ankunft fehlende Tonpakete (`buendel_ton.verloren`). Was
    /// davon nicht in `verloren` landet, kam noch rechtzeitig nach —
    /// nachgefordert oder spaet umsortiert, der Player trennt das nicht.
    pub zuerst_gefehlt: u64,
    pub verdeckt: u64,
    pub verdeckt_plc: u64,
    /// Echte Pakete, die erst nach ihrem Ersatzton kamen und verworfen wurden.
    pub danach_verworfen: u64,
    pub unterlaeufe: u64,
    /// Lief ueberhaupt eine Tonausgabe? Nur fuer die Schlusszeile.
    pub ton_lief: bool,
    /// Zwei Momentwerte wie `Bildstand::betriebsart`: ueber welchen Weg der
    /// Ton hinausgeht und wie lange er vom Geraete-Abruf bis zum Lautsprecher
    /// braucht (0 = unbekannt). Die Verzoegerung steckt nicht in der
    /// Bild/Ton-Messung (`crate::bildton`) — ohne diese Zahl im Dauerprotokoll
    /// blieb sie bis zum 2026-10-22 eine Schaetzung.
    pub weg: &'static str,
    pub ausgabe_ms: u64,
}

impl Tonstand {
    /// "; Ausgabe 12 ms ueber PipeWire", solange ein Weg bekannt ist.
    fn ausgabe(&self) -> String {
        match (self.weg, self.ausgabe_ms) {
            ("", _) => String::new(),
            (weg, 0) => format!("; Ausgabe ueber {weg}"),
            (weg, ms) => format!("; Ausgabe {ms} ms ueber {weg}"),
        }
    }
}

impl Stand for Tonstand {
    const NAME: &'static str = "Ton-Zaehlung";

    fn seit(&self, alt: &Self) -> Self {
        Self {
            verloren: self.verloren.saturating_sub(alt.verloren),
            luecken: self.luecken.seit(&alt.luecken),
            zuerst_gefehlt: self.zuerst_gefehlt.saturating_sub(alt.zuerst_gefehlt),
            verdeckt: self.verdeckt.saturating_sub(alt.verdeckt),
            verdeckt_plc: self.verdeckt_plc.saturating_sub(alt.verdeckt_plc),
            danach_verworfen: self.danach_verworfen.saturating_sub(alt.danach_verworfen),
            unterlaeufe: self.unterlaeufe.saturating_sub(alt.unterlaeufe),
            ton_lief: self.ton_lief,
            weg: self.weg,
            ausgabe_ms: self.ausgabe_ms,
        }
    }

    fn leer(&self) -> bool {
        Self { ton_lief: false, weg: "", ausgabe_ms: 0, ..*self } == Self::default()
    }

    fn text(&self) -> String {
        format!(
            "verloren {} (Luecken {}), bei Ankunft fehlten {}, verdeckt {} (PLC {}, \
             danach verworfen {}), Unterlaeufe {}{}",
            self.verloren,
            self.luecken.text(),
            self.zuerst_gefehlt,
            self.verdeckt,
            self.verdeckt_plc,
            self.danach_verworfen,
            self.unterlaeufe,
            self.ausgabe(),
        )
    }

    fn nichts(&self) -> String {
        if self.ton_lief {
            format!("nichts gefehlt{}", self.ausgabe())
        } else {
            "kein Ton gelaufen".into()
        }
    }
}

/// Bild, kumuliert je Sitzung — dazu zwei Momentwerte (Betriebsart, Vorhalt),
/// die nur beschreiben und kein Ereignis sind.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Bildstand {
    /// Nach ihrem Zielzeitpunkt eingetroffen (Ausgabe-Takt; bei Vorhalt 0
    /// immer 0, dort gibt es keinen Zielzeitpunkt).
    pub verspaetet: u64,
    /// Ueberschrieben, bevor sie gezeichnet werden konnten — darunter die, die
    /// der Takt beim spaeten Aufwachen ueberspringt.
    pub uebersprungen: u64,
    /// Vor ihrem Zielzeitpunkt aus der Warteschlange gefallen (muss 0 sein).
    pub verdraengt: u64,
    /// Vom Decoder-Faden verworfen, weil die Darstellung nicht mitkam.
    pub decoder_rueckstand: u64,
    /// Ausgabe-Abstaende ueber dem Doppelten des Sollabstands: was man als
    /// Stehen des Bildes sieht.
    pub standluecken: u64,
    /// Nach einer Paketluecke als unsauber verworfen.
    pub nach_paketluecke: u64,
    /// Verlorene Bildpakete laut Jitter-Puffer, nach Nachforderung und Paritaet.
    pub paketverlust: u64,
    /// Neue Ziele des Vorhalt-Reglers.
    pub vorhalt_stufen: u64,
    pub betriebsart: &'static str,
    pub vorhalt_ms: u64,
}

impl Stand for Bildstand {
    const NAME: &'static str = "Bild-Zaehlung";

    fn seit(&self, alt: &Self) -> Self {
        Self {
            verspaetet: self.verspaetet.saturating_sub(alt.verspaetet),
            uebersprungen: self.uebersprungen.saturating_sub(alt.uebersprungen),
            verdraengt: self.verdraengt.saturating_sub(alt.verdraengt),
            decoder_rueckstand: self.decoder_rueckstand.saturating_sub(alt.decoder_rueckstand),
            standluecken: self.standluecken.saturating_sub(alt.standluecken),
            nach_paketluecke: self.nach_paketluecke.saturating_sub(alt.nach_paketluecke),
            paketverlust: self.paketverlust.saturating_sub(alt.paketverlust),
            vorhalt_stufen: self.vorhalt_stufen.saturating_sub(alt.vorhalt_stufen),
            betriebsart: self.betriebsart,
            vorhalt_ms: self.vorhalt_ms,
        }
    }

    fn leer(&self) -> bool {
        Self { betriebsart: "", vorhalt_ms: 0, ..*self } == Self::default()
    }

    fn text(&self) -> String {
        format!(
            "verspaetet {}, uebersprungen {}, verdraengt {}, Decoder-Rueckstand {}, \
             Standluecken {}, nach Paketluecke verworfen {}, Paketverlust {}, \
             Vorhalt-Stufen {}; {}, Vorhalt {} ms",
            self.verspaetet,
            self.uebersprungen,
            self.verdraengt,
            self.decoder_rueckstand,
            self.standluecken,
            self.nach_paketluecke,
            self.paketverlust,
            self.vorhalt_stufen,
            self.betriebsart,
            self.vorhalt_ms,
        )
    }

    fn nichts(&self) -> String {
        format!("nichts aufgefallen; {}, Vorhalt {} ms", self.betriebsart, self.vorhalt_ms)
    }
}

/// Wann eine Zeile faellig ist — je Art und Sitzung einer.
#[derive(Debug)]
pub struct Meldetakt<S: Stand> {
    beginn: Instant,
    zuletzt: Option<Instant>,
    gemeldet: S,
}

impl<S: Stand> Default for Meldetakt<S> {
    fn default() -> Self {
        Self::ab(Instant::now())
    }
}

impl<S: Stand> Meldetakt<S> {
    fn ab(beginn: Instant) -> Self {
        Self { beginn, zuletzt: None, gemeldet: S::default() }
    }

    /// Die Zeile, falls faellig. `zum_schluss` = Sitzungsende: dann IMMER
    /// eine, und zwar mit dem Stand der ganzen Sitzung.
    pub fn melden(&mut self, jetzt: Instant, stand: S, zum_schluss: bool) -> Option<String> {
        if zum_schluss {
            let dauer = jetzt.saturating_duration_since(self.beginn);
            let text = if stand.leer() { stand.nichts() } else { stand.text() };
            return Some(format!("{} Sitzung ({} s) — {text}", S::NAME, komma(dauer)));
        }
        let neu = stand.seit(&self.gemeldet);
        if neu.leer() {
            return None;
        }
        if self.zuletzt.is_some_and(|t| jetzt.saturating_duration_since(t) < MELDEABSTAND) {
            return None;
        }
        let fenster = jetzt.saturating_duration_since(self.zuletzt.unwrap_or(self.beginn));
        self.zuletzt = Some(jetzt);
        self.gemeldet = stand;
        Some(format!("{} ({} s) — {}", S::NAME, komma(fenster), neu.text()))
    }
}

/// Beide Meldetakte einer Sitzung.
#[derive(Debug, Default)]
pub struct Zaehlung {
    pub bild: Meldetakt<Bildstand>,
    pub ton: Meldetakt<Tonstand>,
}

/// Eine Nachkommastelle, deutsches Komma — wie die Sender-Zeile.
fn komma(d: Duration) -> String {
    format!("{:.1}", d.as_secs_f64()).replace('.', ",")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ton(verloren: u64) -> Tonstand {
        Tonstand { verloren, ton_lief: true, ..Tonstand::default() }
    }

    #[test]
    fn lueckenlaengen_landen_in_ihrer_stufe() {
        let mut l = Lueckenstufen::default();
        for n in [1, 1, 2, 3, 4, 9, 10, 500, 0] {
            l.buchen(n);
        }
        assert_eq!(l.stufen, [2, 1, 1, 2, 2], "0 bucht nichts, 4 und 9 teilen eine Stufe");
        assert_eq!(l.text(), "1:2 2:1 3:1 4-9:2 10+:2");
    }

    /// **Keine Zeile ohne Ereignis** — auch nicht nach Ablauf der Minute.
    #[test]
    fn ohne_ereignis_keine_zeile() {
        let t0 = Instant::now();
        let mut m = Meldetakt::<Tonstand>::ab(t0);
        for s in [1, 30, 61, 300] {
            assert_eq!(m.melden(t0 + Duration::from_secs(s), ton(0), false), None);
        }
        let mut b = Meldetakt::<Bildstand>::ab(t0);
        let stand = Bildstand { betriebsart: "fern sofort", vorhalt_ms: 0, ..Default::default() };
        assert_eq!(b.melden(t0 + Duration::from_secs(90), stand, false), None);
    }

    /// Ein Ereignis meldet sofort, die naechsten erst nach einer Minute — und
    /// dann mit allem, was inzwischen dazukam.
    #[test]
    fn hoechstens_eine_zeile_je_minute_mit_dem_zuwachs() {
        let t0 = Instant::now();
        let mut m = Meldetakt::<Tonstand>::ab(t0);
        let z = m.melden(t0 + Duration::from_secs(5), ton(2), false).expect("erste Zeile");
        assert!(z.starts_with("Ton-Zaehlung (5,0 s) — verloren 2"), "{z}");
        assert_eq!(m.melden(t0 + Duration::from_secs(30), ton(5), false), None, "zu frueh");
        let z = m.melden(t0 + Duration::from_secs(66), ton(7), false).expect("nach der Minute");
        assert!(z.starts_with("Ton-Zaehlung (61,0 s) — verloren 5 "), "Zuwachs, nicht Summe: {z}");
    }

    /// Zum Schluss immer eine Zeile, auch ohne jedes Ereignis — mit dem Stand
    /// der ganzen Sitzung, nicht dem Zuwachs.
    #[test]
    fn zum_schluss_immer_mit_der_ganzen_sitzung() {
        let t0 = Instant::now();
        let mut m = Meldetakt::<Tonstand>::ab(t0);
        let z = m.melden(t0 + Duration::from_secs(10), ton(0), true).expect("immer");
        assert_eq!(z, "Ton-Zaehlung Sitzung (10,0 s) — nichts gefehlt");
        let still = Tonstand::default();
        let z = m.melden(t0 + Duration::from_secs(10), still, true).expect("immer");
        assert!(z.ends_with("kein Ton gelaufen"), "{z}");

        let _ = m.melden(t0 + Duration::from_secs(5), ton(3), false);
        let z = m.melden(t0 + Duration::from_secs(20), ton(4), true).expect("immer");
        assert!(z.starts_with("Ton-Zaehlung Sitzung (20,0 s) — verloren 4 "), "{z}");
    }

    /// Betriebsart und Vorhalt beschreiben nur: ein Wechsel allein ist kein
    /// Ereignis, ein Zaehler schon.
    #[test]
    fn bild_zaehlt_nur_zaehler_als_ereignis() {
        let t0 = Instant::now();
        let mut m = Meldetakt::<Bildstand>::ab(t0);
        let ruhig = Bildstand { betriebsart: "fern geglaettet", vorhalt_ms: 45, ..Default::default() };
        assert_eq!(m.melden(t0 + Duration::from_secs(1), ruhig, false), None);
        let stufe = Bildstand { vorhalt_stufen: 1, ..ruhig };
        let z = m.melden(t0 + Duration::from_secs(2), stufe, false).expect("Ereignis");
        assert!(z.contains("Vorhalt-Stufen 1; fern geglaettet, Vorhalt 45 ms"), "{z}");
        let z = m.melden(t0 + Duration::from_secs(3), stufe, true).expect("Schluss");
        assert!(z.starts_with("Bild-Zaehlung Sitzung (3,0 s) — verspaetet 0"), "{z}");
        let mut leer = Meldetakt::<Bildstand>::ab(t0);
        let z = leer.melden(t0 + Duration::from_secs(3), ruhig, true).expect("Schluss");
        assert!(z.ends_with("nichts aufgefallen; fern geglaettet, Vorhalt 45 ms"), "{z}");
    }
}
