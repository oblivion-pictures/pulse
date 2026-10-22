//! Der Bezug der Lippen-Regelung: das gezeigte Bild, beide Spuren in der Uhr
//! der Sender Reports — die gemeinsame Uhr (seit 2026-10-22).
//!
//! **Was vorher galt** ([`super::lippen`]): der Ton regelte gegen seine EIGENE
//! Ankunft (Mindest-Latenz-Anker), das Bild verankerte sich getrennt davon an
//! seiner. Zwei Anker, die niemand gegeneinander pruefte: jeder Unterschied der
//! Wege — Sendelatenz beim Sender, Puffer, Decoder — blieb als Versatz stehen
//! oder wuchs, und der Regler sah ihn nicht, weil er nur den Ton gegen den Ton
//! mass.
//!
//! **Was jetzt gilt.** Das Fenster misst je Statistik-Takt (250 ms), wie weit der
//! gerade klingende Ton hinter dem gerade gezeigten Bild liegt, beide auf die
//! Uhr der Sender Reports abgebildet (`crate::bildton::versatz_ms`). Ist die
//! Messung frisch, ist SIE der Regelfehler. Der bestehende Regler (langsame
//! Nachfuehrung des Ring-Sollwerts, `lippen::nachfuehren`) und der
//! Uhrenabgleich darunter setzen ihn um. Das Bild wartet dabei NIE auf den
//! Ton: in der Fernsteuerung zaehlt jede Millisekunde, und beim Zusehen kaeme
//! sonst Verzoegerung dazu. Liegt der Ton weiter hinter dem Bild, als der Ring
//! hergibt (Untergrenze `ringregelung::RING_BODEN_MS`), bleibt der Rest stehen —
//! die Zeile „Bild/Ton" im Log nennt ihn.
//!
//! **Was „Uhr der Sender Reports" bedeutet**, haengt am Weg: mit einem Sender
//! ab Desktop 0.1.130 und MediaMTX mit `useAbsoluteTimestamp` die
//! AUFNAHMEZEIT beim Sender (`pulse-whip/src/senderbericht.rs`); mit einem
//! alten Server die Ankunft dort (dann misst die Regelung nur den Anteil ab
//! dem Server); mit einem alten Sender auf dem Direktweg dessen Sendezeit.
//! Alle drei sind besser als zwei getrennte Anker.
//!
//! **Rueckfall**: ohne frische Messung (keine Reports, kein Bild, Messung
//! unplausibel) regelt der Ton wie vorher gegen seine Ankunft.

use std::time::{Duration, Instant};

/// Woran die Lippen-Regelung gerade misst.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bezug {
    /// Am gezeigten Bild, in der Uhr der Sender Reports.
    Bild,
    /// An der eigenen Ankunft des Tons (Rueckfall).
    Ankunft,
}

impl Bezug {
    /// Die Logzeile beim Wechsel — einmal, nicht je Paket.
    pub fn zeile(self) -> &'static str {
        match self {
            Self::Bild => {
                "pulse-player: Lippen-Synchronisation regelt den Ton gegen das gezeigte Bild \
                 (gemeinsame Uhr der Sender Reports)"
            }
            Self::Ankunft => {
                "pulse-player: Lippen-Synchronisation ohne gemeinsame Uhr — der Ton regelt \
                 gegen seine eigene Ankunft (keine frische Bild/Ton-Messung)"
            }
        }
    }
}

/// So alt darf eine Messung hoechstens sein. Sie kommt alle 250 ms; sechs
/// ausgefallene Takte am Stueck heissen, dass etwas fehlt (Reports, Bild).
const FRISCH: Duration = Duration::from_millis(1_500);

/// Der Regelfehler aus dem gemessenen Bild/Ton-Versatz, solange er frisch ist.
///
/// `trim_ms` = Nutz-Trim `av_offset_ms` (positiv = Ton spaeter): um so viel
/// SOLL der Ton hinter dem Bild liegen. Ohne den Abzug regelte die gemeinsame
/// Uhr jeden Trim binnen Minuten wieder weg.
pub fn fehler(bildton: Option<(f64, Instant)>, trim_ms: i32, jetzt: Instant) -> Option<f64> {
    let (versatz_ms, gemessen) = bildton?;
    let alter = jetzt.checked_duration_since(gemessen).unwrap_or_default();
    (alter <= FRISCH).then(|| versatz_ms - f64::from(trim_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frisch zaehlt die Messung, abzueglich des Trims — in beide Richtungen.
    #[test]
    fn frische_messung_ist_der_fehler() {
        let t = Instant::now();
        assert_eq!(fehler(Some((42.0, t)), 0, t + Duration::from_millis(300)), Some(42.0));
        assert_eq!(fehler(Some((42.0, t)), 100, t), Some(-58.0), "Ton soll 100 ms spaeter");
        assert_eq!(fehler(Some((-20.0, t)), -50, t), Some(30.0), "Ton soll 50 ms frueher");
    }

    /// Ohne Messung oder mit einer alten gilt der Rueckfall.
    #[test]
    fn ohne_frische_messung_kein_fehler() {
        let t = Instant::now();
        assert_eq!(fehler(None, 0, t), None);
        assert_eq!(fehler(Some((10.0, t)), 0, t + Duration::from_millis(1_600)), None);
    }

    /// Eine Messung „aus der Zukunft" (Uhrlesung auf zwei Faeden) ist frisch,
    /// keine Panik.
    #[test]
    fn messung_nach_jetzt_ist_frisch() {
        let t = Instant::now();
        assert_eq!(fehler(Some((5.0, t + Duration::from_millis(3))), 0, t), Some(5.0));
    }
}
