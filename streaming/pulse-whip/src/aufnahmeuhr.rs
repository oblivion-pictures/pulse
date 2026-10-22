//! Die Aufnahmeuhr einer Verbindung: auf welchen Augenblick der gemeinsame
//! pts-Nullpunkt von Bild und Ton faellt — damit die Senderberichte
//! ([`crate::senderbericht`]) beider Spuren die AUFNAHMEZEIT tragen statt der
//! Sendezeit.
//!
//! **Warum das noetig ist** (Plan `intern/docs/plans/2026-10-16-bild-ton-sync-
//! plan.md`, Befund B5). Der Senderbericht von webrtc-rs bildet die RTP-Marke
//! des zuletzt GESCHRIEBENEN Pakets auf die Wanduhr beim Schreiben ab. Bild und
//! Ton erreichen diese Stelle verschieden spaet — das Bild nach dem Taktgeber
//! (`pacer`), ein Vollbild bis zu Zehntelsekunden spaeter als seine Aufnahme —,
//! und jeder Unterschied ihrer Sendelatenz wird beim Zuschauer zum Bild/Ton-
//! Versatz. Mit der Aufnahmeuhr gilt fuer BEIDE Spuren dieselbe Abbildung
//! „pts p wurde um Ursprung + p aufgenommen", und die Sendelatenz faellt
//! heraus.
//!
//! **Woher der Ursprung kommt.** Alle drei Sidecars zaehlen die pts beider
//! Spuren ab einem gemeinsamen Nullpunkt (Windows `origin_qpc`, Linux
//! `record_start`, macOS `epoch_s`), aber nur Windows und Linux kennen ihn als
//! `Instant`. Statt ihn durch drei Sidecars zu reichen, wird er hier beim
//! ERSTEN Paket geschaetzt: Ursprung = jetzt − pts dieses Pakets. Der Fehler
//! ist dessen Sendelatenz (einige zehn ms) und gilt fuer beide Spuren gleich —
//! er verschiebt die Zeitangabe als Ganzes, nie Bild gegen Ton.
//!
//! **Was die RTP-Marken dafuer sein muessen.** Bild: Marke = pts in 90 kHz
//! (`av1::SpurZustand::zeitstempel` reicht ihn unveraendert durch, Basis 0).
//! Ton: Marke = Basis + pts in 48 kHz (`ton::TonSpur` setzt sie so und meldet
//! ihre Basis hier an). Eine Spur, deren Marke NICHT am pts haengt, bekaeme
//! einen falschen Bericht — deshalb gibt es fuer andere Taktraten keinen.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Takt der Bildspur (RTP-Uhr aller Video-Codecs, s. `crate::zeitbasis`).
pub const BILD_HZ: u32 = 90_000;
/// Takt der Tonspur (Opus, RFC 7587).
pub const TON_HZ: u32 = 48_000;

/// Welche Spur — entschieden am Takt der gebundenen Fassung.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Spur {
    Bild,
    Ton,
}

impl Spur {
    /// Bild bei 90 kHz, Ton bei 48 kHz; alles andere stempeln wir nicht selbst.
    pub fn aus_takt(takt_hz: u32) -> Option<Self> {
        match takt_hz {
            BILD_HZ => Some(Self::Bild),
            TON_HZ => Some(Self::Ton),
            _ => None,
        }
    }

    fn takt(self) -> f64 {
        match self {
            Self::Bild => f64::from(BILD_HZ),
            Self::Ton => f64::from(TON_HZ),
        }
    }
}

/// Geteilt zwischen der Tonspur (meldet ihre Basis) und dem Senderbericht
/// (schaetzt den Ursprung, rechnet die Marke fuer „jetzt").
#[derive(Default)]
pub struct Aufnahmeuhr {
    ursprung: OnceLock<Instant>,
    ton_basis: OnceLock<u32>,
}

impl Aufnahmeuhr {
    pub fn neu() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Die Ton-Marke bei pts 0. Einmal; die Tonspur waehlt sie beim Bau.
    pub fn ton_basis_setzen(&self, basis: u32) {
        let _ = self.ton_basis.set(basis);
    }

    fn basis(&self, spur: Spur) -> Option<u32> {
        match spur {
            Spur::Bild => Some(0),
            Spur::Ton => self.ton_basis.get().copied(),
        }
    }

    /// Ein Paket geht hinaus. Beim ersten der ganzen Verbindung wird daraus
    /// der Ursprung geschaetzt (s. Modulkopf); danach aendert sich nichts mehr.
    pub fn paket(&self, spur: Spur, rtp: u32, jetzt: Instant) {
        if self.ursprung.get().is_some() {
            return;
        }
        let Some(basis) = self.basis(spur) else { return };
        // Vorzeichenbehaftet: eine Marke knapp UNTER der Basis ist ein pts
        // knapp unter null (macOS-Audio vor dem ersten Bild), kein Tag Laufzeit.
        let pts_s = f64::from(rtp.wrapping_sub(basis) as i32) / spur.takt();
        let ursprung = if pts_s >= 0.0 {
            jetzt.checked_sub(Duration::from_secs_f64(pts_s))
        } else {
            jetzt.checked_add(Duration::from_secs_f64(-pts_s))
        };
        if let Some(u) = ursprung {
            let _ = self.ursprung.set(u);
        }
    }

    /// Die Marke, die eine JETZT aufgenommene Probe dieser Spur truege — der
    /// RTP-Teil des Senderberichts. `None`, solange kein Paket hinaus ist (dann
    /// gibt es nichts abzubilden) oder die Tonspur ihre Basis nicht gemeldet hat.
    pub fn marke_jetzt(&self, spur: Spur, jetzt: Instant) -> Option<u32> {
        let ursprung = *self.ursprung.get()?;
        let basis = self.basis(spur)?;
        let seit_s = match jetzt.checked_duration_since(ursprung) {
            Some(d) => d.as_secs_f64(),
            None => -ursprung.duration_since(jetzt).as_secs_f64(),
        };
        // `as i64 as u32`: die Marke laeuft ueber wie jede RTP-Uhr (RFC 3550).
        Some(basis.wrapping_add((seit_s * spur.takt()).round() as i64 as u32))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Kern: Bild und Ton bilden denselben Augenblick auf ihre Marken ab.
    /// Hat der Bericht des Bildes „jetzt = Marke B" und der des Tons „jetzt =
    /// Marke T", dann muessen B und T zu Paketen gehoeren, deren pts gleich
    /// sind — sonst klingt der Ton beim Zuschauer um die Differenz versetzt.
    #[test]
    fn bild_und_ton_haengen_am_selben_ursprung() {
        let uhr = Aufnahmeuhr::default();
        uhr.ton_basis_setzen(1_000_000);
        let t0 = Instant::now();
        // Erstes Paket: Bild mit pts 0,5 s, gesendet bei t0.
        uhr.paket(Spur::Bild, 45_000, t0);
        let spaeter = t0 + Duration::from_millis(2_000);
        let bild = uhr.marke_jetzt(Spur::Bild, spaeter).unwrap();
        let ton = uhr.marke_jetzt(Spur::Ton, spaeter).unwrap();
        // 2 s nach t0 sind 2,5 s pts.
        assert_eq!(bild, 225_000);
        assert_eq!(ton, 1_000_000 + 120_000);
    }

    /// Spaetere Pakete verschieben den Ursprung nicht: der Bericht soll die
    /// Aufnahmeuhr abbilden, nicht die Latenz des gerade gesendeten Pakets.
    #[test]
    fn nur_das_erste_paket_setzt_den_ursprung() {
        let uhr = Aufnahmeuhr::default();
        let t0 = Instant::now();
        uhr.paket(Spur::Bild, 0, t0);
        uhr.paket(Spur::Bild, 90_000, t0 + Duration::from_millis(1_300));
        assert_eq!(uhr.marke_jetzt(Spur::Bild, t0 + Duration::from_secs(1)), Some(90_000));
    }

    /// Ohne gesendetes Paket und ohne Ton-Basis gibt es keinen Bericht —
    /// lieber keiner als einer mit erfundener Abbildung.
    #[test]
    fn ohne_anlass_kein_bericht() {
        let uhr = Aufnahmeuhr::default();
        let t0 = Instant::now();
        assert_eq!(uhr.marke_jetzt(Spur::Bild, t0), None);
        uhr.paket(Spur::Ton, 500, t0);
        assert_eq!(uhr.marke_jetzt(Spur::Bild, t0), None, "Ton ohne Basis setzt nichts");
        uhr.paket(Spur::Bild, 0, t0);
        assert_eq!(uhr.marke_jetzt(Spur::Ton, t0), None, "Ton ohne Basis bleibt ohne Bericht");
        assert_eq!(uhr.marke_jetzt(Spur::Bild, t0), Some(0));
    }

    /// Das erste Paket darf der Ton sein, auch mit einer Marke knapp unter der
    /// Basis (pts < 0) und ueber den 32-Bit-Ueberlauf der Basis hinweg.
    #[test]
    fn ton_zuerst_und_ueber_den_ueberlauf() {
        let uhr = Aufnahmeuhr::default();
        uhr.ton_basis_setzen(u32::MAX - 100);
        let t0 = Instant::now() + Duration::from_secs(10);
        // pts = -480 (10 ms vor dem Nullpunkt).
        uhr.paket(Spur::Ton, (u32::MAX - 100).wrapping_sub(480), t0);
        // 10 ms spaeter ist pts 0: Ton-Marke = Basis, Bild-Marke = 0.
        let spaeter = t0 + Duration::from_millis(10);
        assert_eq!(uhr.marke_jetzt(Spur::Ton, spaeter), Some(u32::MAX - 100));
        assert_eq!(uhr.marke_jetzt(Spur::Bild, spaeter), Some(0));
        // Und 1 s weiter laeuft die Ton-Marke ueber.
        let weiter = spaeter + Duration::from_secs(1);
        assert_eq!(uhr.marke_jetzt(Spur::Ton, weiter), Some((u32::MAX - 100).wrapping_add(48_000)));
    }

    #[test]
    fn spur_am_takt() {
        assert_eq!(Spur::aus_takt(90_000), Some(Spur::Bild));
        assert_eq!(Spur::aus_takt(48_000), Some(Spur::Ton));
        assert_eq!(Spur::aus_takt(8_000), None);
    }
}
