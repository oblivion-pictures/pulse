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
//! **Seit dem 2026-10-27** misst die Zeile, was man SIEHT und HOERT (Ton samt
//! gemeldeter Ausgabelatenz, Bild samt Anzeige-Latenz, `crate::bildton`), die
//! Messungen werden geglaettet ([`glaetten`], rund 4 s), und unter
//! [`TOTBAND_MS`] stellt der Regler nicht nach. Der Lippenfehler der
//! Statistik (`AudioCounters::lippen_ms`) ist am Bild damit der geglaettete.
//!
//! **Was „Uhr der Sender Reports" bedeutet**, haengt am Weg: mit einem Sender
//! ab Desktop 0.1.130 und MediaMTX mit `useAbsoluteTimestamp` die
//! AUFNAHMEZEIT beim Sender (`pulse-whip/src/senderbericht.rs`); mit einem
//! alten Server die Ankunft dort (dann misst die Regelung nur den Anteil ab
//! dem Server); mit einem alten Sender auf dem Direktweg dessen Sendezeit.
//! Alle drei sind besser als zwei getrennte Anker.
//!
//! **Rueckfall**: ohne frische Messung (keine Reports, kein Bild, Messung
//! unplausibel) regelt der Ton wie vorher gegen seine Ankunft — aber nur,
//! solange noch nie am Bild geregelt wurde. Danach haelt eine Messpause den
//! Eingriff fest (`fuetterung.rs`): die Ankunft zielt woanders hin, und ein
//! Wechsel machte nach jedem Standbild zunichte, was die Messung erreicht hat.

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

/// Totband der Regelung am Bild in ms: liegt der GEGLAETTETE Fehler darunter,
/// stellt der Regler nicht nach (seit 2026-10-27).
///
/// **Vorbild libwebrtc** (`video/stream_synchronization.cc`,
/// https://webrtc.googlesource.com/src/+/main/video/stream_synchronization.cc):
/// `kMinDeltaMs = 30` — „Minimum difference between audio and video to
/// warrant a change" —, geprueft gegen `avg_diff_ms_`, das mit
/// `kFilterLength = 4` je Abgleich geglaettet wird (ein Abgleich je Sekunde,
/// `kSyncInterval` in `rtp_streams_synchronizer2.cc`). Grund hier: am
/// 2026-10-27 (Linux-Player, Fernsteuerung eines Windows-Rechners) stand der
/// Eingriff fast die ganze Zeit am Anschlag, waehrend Bild/Ton zwischen ±15 und
/// ±35 ms pendelte — jeder Schwankung lief der Regler hinterher. 30 ms liegen
/// unter der Erkennbarkeitsschwelle von ITU-R BT.1359 (Ton VOR dem Bild ab
/// rund 45 ms, Ton NACH dem Bild ab rund 125 ms). Preis: ein Rest bis 30 ms
/// bleibt bewusst stehen — der Regler fuehrt nur bis an den Rand des Bands.
pub const TOTBAND_MS: f64 = 30.0;

/// Gewicht einer neuen Messung in der Glaettung: 1/16 je Messung (alle
/// 250 ms) entspricht libwebrtcs 1/4 je Sekunde — Zeitkonstante rund 4 s,
/// gerechnet, nicht gemessen.
const GLAETTUNG: f64 = 1.0 / 16.0;

/// Eine neue Messung `versatz_ms` (gemessen um `gemessen`) in den geglaetteten
/// Stand einrechnen. Ohne frischen Vorgaenger beginnt die Glaettung neu, statt
/// einen Wert von vor einer Messpause mitzuschleppen.
pub fn glaetten(vorher: Option<(f64, Instant)>, versatz_ms: f64, gemessen: Instant) -> f64 {
    match vorher {
        Some((mittel, zuletzt))
            if gemessen.checked_duration_since(zuletzt).unwrap_or_default() <= FRISCH =>
        {
            mittel + (versatz_ms - mittel) * GLAETTUNG
        }
        _ => versatz_ms,
    }
}

/// Darf der Regler mit diesem (geglaetteten) Fehler nachstellen?
pub fn ausserhalb_totband(fehler_ms: f64) -> bool {
    fehler_ms.abs() >= TOTBAND_MS
}

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

    /// Die Glaettung folgt einer neuen Messung um 1/16, ein Sprung von 32 ms
    /// bewegt den Stand also um 2 ms; nach einer Messpause beginnt sie neu.
    #[test]
    fn glaettung_folgt_langsam_und_beginnt_nach_pause_neu() {
        let t = Instant::now();
        assert_eq!(glaetten(None, 20.0, t), 20.0, "erste Messung");
        let m = glaetten(Some((20.0, t)), 52.0, t + Duration::from_millis(250));
        assert!((m - 22.0).abs() < 1e-9, "{m}");
        let neu = glaetten(Some((20.0, t)), 52.0, t + Duration::from_millis(1_600));
        assert_eq!(neu, 52.0, "nach der Pause zaehlt die neue Messung allein");
        // 16 Messungen von je +40 ms aus 0: nach rund 4 s gut 60 % des Wegs.
        let mut m = (0.0, t);
        for k in 1..=16u64 {
            let jetzt = t + Duration::from_millis(250 * k);
            m = (glaetten(Some(m), 40.0, jetzt), jetzt);
        }
        assert!((24.0..=26.5).contains(&m.0), "{}", m.0);
    }

    /// Unter 30 ms wird nicht nachgestellt, ab 30 ms in beide Richtungen.
    #[test]
    fn totband_haelt_unter_dreissig_ms() {
        assert!(!ausserhalb_totband(0.0));
        assert!(!ausserhalb_totband(29.9));
        assert!(!ausserhalb_totband(-29.9));
        assert!(ausserhalb_totband(30.0));
        assert!(ausserhalb_totband(-45.0));
    }

    /// Eine Messung „aus der Zukunft" (Uhrlesung auf zwei Faeden) ist frisch,
    /// keine Panik.
    #[test]
    fn messung_nach_jetzt_ist_frisch() {
        let t = Instant::now();
        assert_eq!(fehler(Some((5.0, t + Duration::from_millis(3))), 0, t), Some(5.0));
    }
}
