//! RED (RFC 2198) fuer den Ton auf der Strecke Sender -> Server: jedes
//! Opus-Paket traegt die letzten `kopien` Pakete noch einmal mit.
//!
//! **Format.** Vor den Nutzdaten steht je Redundanzblock ein 4-Byte-Kopf
//! (Bit F=1, 7 bit Block-PT, 14 bit Zeitstempel-Abstand „Primaer minus
//! Block“, 10 bit Laenge), vor dem Primaerblock ein 1-Byte-Kopf (F=0, 7 bit
//! PT). Die Daten folgen in der Reihenfolge der Koepfe: aeltester
//! Redundanzblock zuerst, Primaerblock zuletzt.
//!
//! **Grenzen.** Abstand <= 16383 Takte (14 bit), Laenge <= 1023 Byte
//! (10 bit). Reisst ein Block eine Grenze, entfaellt er UND alles Aeltere:
//! die Bloecke muessen lueckenlos an das Primaerpaket anschliessen, denn der
//! Server rechnet die Sequenznummer eines Blocks aus seiner Position
//! (`seq - k`). Ein Loch in der Kette ergaebe falsch nummerierte Pakete.
//!
//! Rein und synchron: kein Netz, keine Uhr; der Aufrufer gibt Zeitstempel
//! und Block-PT mit.

use std::collections::VecDeque;

/// Standard: so viele Kopien traegt ein Paket mit.
pub const KOPIEN_VORGABE: u8 = 2;
/// Obergrenze der einstellbaren Kopienzahl.
pub const KOPIEN_MAX: u8 = 3;
/// Umgebungsvariable zum Einstellen (0 = kein RED).
pub const UMGEBUNG: &str = "PULSE_OPUS_RED_KOPIEN";

const ABSTAND_MAX: u32 = (1 << 14) - 1;
const LAENGE_MAX: usize = (1 << 10) - 1;

/// Prueft einen Rohwert: `None` -> Vorgabe, sonst Zahl in `0..=KOPIEN_MAX`.
pub fn kopien_parsen(roh: Option<&str>) -> Result<u8, String> {
    let Some(roh) = roh else {
        return Ok(KOPIEN_VORGABE);
    };
    match roh.trim().parse::<u8>() {
        Ok(n) if n <= KOPIEN_MAX => Ok(n),
        _ => Err(format!(
            "{UMGEBUNG}={roh:?} ist ungueltig (erlaubt: 0..={KOPIEN_MAX})"
        )),
    }
}

/// Liest [`UMGEBUNG`]; bei unlesbarem Wert Warnung und [`KOPIEN_VORGABE`].
pub fn kopien_aus_umgebung() -> u8 {
    let roh = std::env::var(UMGEBUNG).ok();
    kopien_parsen(roh.as_deref()).unwrap_or_else(|e| {
        eprintln!("{e}; nehme {KOPIEN_VORGABE}");
        KOPIEN_VORGABE
    })
}

/// Baut aus Opus-Paketen RED-Nutzlasten und merkt sich dafuer den Verlauf.
pub struct RedPacker {
    kopien: usize,
    verlauf: VecDeque<(u32, Vec<u8>)>,
}

impl RedPacker {
    pub fn neu(kopien: u8) -> Self {
        Self {
            kopien: usize::from(kopien.min(KOPIEN_MAX)),
            verlauf: VecDeque::new(),
        }
    }

    /// Nutzlast fuer das Paket mit `zeitstempel`; `block_pt` ist die
    /// Opus-PT, die in jedem Kopf steht.
    pub fn packen(&mut self, zeitstempel: u32, block_pt: u8, opus: &[u8]) -> Vec<u8> {
        // Vom juengsten rueckwaerts, beim ersten Block ausserhalb der Grenzen Schluss.
        let mut gewaehlt: Vec<&(u32, Vec<u8>)> = self
            .verlauf
            .iter()
            .rev()
            .take_while(|(ts, daten)| {
                zeitstempel.wrapping_sub(*ts) <= ABSTAND_MAX && daten.len() <= LAENGE_MAX
            })
            .collect();
        gewaehlt.reverse();

        let mut aus = Vec::with_capacity(
            gewaehlt.iter().map(|(_, d)| 4 + d.len()).sum::<usize>() + 1 + opus.len(),
        );
        for (ts, daten) in &gewaehlt {
            let abstand = zeitstempel.wrapping_sub(*ts);
            let wort = (abstand << 10) | daten.len() as u32;
            aus.push(0x80 | (block_pt & 0x7f));
            aus.extend_from_slice(&wort.to_be_bytes()[1..]);
        }
        aus.push(block_pt & 0x7f);
        for (_, daten) in &gewaehlt {
            aus.extend_from_slice(daten);
        }
        aus.extend_from_slice(opus);

        if self.kopien > 0 {
            if self.verlauf.len() == self.kopien {
                self.verlauf.pop_front();
            }
            self.verlauf.push_back((zeitstempel, opus.to_vec()));
        }
        aus
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kopf(pt: u8, abstand: u32, laenge: usize) -> [u8; 4] {
        [
            0x80 | pt,
            (abstand >> 6) as u8,
            (((abstand & 0x3f) << 2) as u8) | ((laenge >> 8) as u8),
            laenge as u8,
        ]
    }

    #[test]
    fn erstes_paket_hat_nur_den_primaerblock() {
        assert_eq!(RedPacker::neu(2).packen(1000, 111, &[1, 2, 3]), [111, 1, 2, 3]);
    }

    #[test]
    fn zwei_kopien_in_der_richtigen_reihenfolge() {
        let mut p = RedPacker::neu(2);
        p.packen(0, 111, &[0xA]);
        p.packen(480, 111, &[0xB, 0xB]);
        let aus = p.packen(960, 111, &[0xC]);
        let mut soll = vec![];
        soll.extend_from_slice(&[0x80 | 111, (960 >> 6) as u8, ((960 & 0x3f) << 2) as u8, 1]);
        soll.extend_from_slice(&[0x80 | 111, (480 >> 6) as u8, ((480 & 0x3f) << 2) as u8, 2]);
        soll.extend_from_slice(&[111, 0xA, 0xB, 0xB, 0xC]);
        assert_eq!(aus, soll);
    }

    #[test]
    fn nie_mehr_als_die_kopienzahl() {
        let mut p = RedPacker::neu(2);
        let mut aus = vec![];
        for i in 0..5u32 {
            aus = p.packen(i * 480, 111, &[1]);
        }
        // 2 Koepfe a 4 Byte + Primaerkopf + 3 Datenbyte
        assert_eq!(aus.len(), 8 + 1 + 3);
        assert_eq!(aus[0] & 0x80, 0x80);
        assert_eq!(aus[4] & 0x80, 0x80);
        assert_eq!(aus[8] & 0x80, 0);
    }

    #[test]
    fn sprung_ueber_14_bit_laesst_kopien_weg() {
        let mut p = RedPacker::neu(2);
        p.packen(0, 111, &[1]);
        assert_eq!(p.packen(16384, 111, &[2]), [111, 2]);
        let aus = p.packen(16864, 111, &[3]);
        let mut soll = kopf(111, 480, 1).to_vec();
        soll.extend_from_slice(&[111, 2, 3]);
        assert_eq!(aus, soll);
    }

    #[test]
    fn zu_langer_block_bricht_die_kette() {
        let mut p = RedPacker::neu(3);
        p.packen(0, 111, &[9]);
        p.packen(480, 111, &vec![7; 1024]);
        p.packen(960, 111, &[2]);
        let aus = p.packen(1440, 111, &[3]);
        // nur die Kopie von 960; der lange Block und der aeltere davor entfallen
        let mut soll = kopf(111, 480, 1).to_vec();
        soll.extend_from_slice(&[111, 2, 3]);
        assert_eq!(aus, soll);
    }

    #[test]
    fn zeitstempel_umbruch() {
        let mut p = RedPacker::neu(2);
        p.packen(u32::MAX - 239, 111, &[1]);
        let aus = p.packen(240, 111, &[2]);
        let mut soll = kopf(111, 480, 1).to_vec();
        soll.extend_from_slice(&[111, 1, 2]);
        assert_eq!(aus, soll);
    }

    #[test]
    fn kopien_null_ist_reines_primaerpaket() {
        let mut p = RedPacker::neu(0);
        assert_eq!(p.packen(0, 111, &[1]), [111, 1]);
        assert_eq!(p.packen(480, 111, &[2]), [111, 2]);
    }

    #[test]
    fn kopien_parsen_grenzen() {
        assert_eq!(kopien_parsen(None), Ok(2));
        assert_eq!(kopien_parsen(Some("0")), Ok(0));
        assert_eq!(kopien_parsen(Some("3")), Ok(3));
        assert!(kopien_parsen(Some("4")).is_err());
        assert!(kopien_parsen(Some("x")).is_err());
        assert!(kopien_parsen(Some("")).is_err());
    }
}
