//! Bild/Ton-Versatz in Sender-Uhrzeit messen — aus den RTCP Sender Reports.
//!
//! **Was hier entsteht, ist eine Messung, kein Regler.** Die Logzeile „Bild/Ton"
//! sagt, wie weit der gerade klingende Ton hinter dem gerade gezeigten Bild
//! liegt, beide in der Uhrzeit, die die Gegenstelle ihren Sender Reports
//! mitgibt. Die Kopplung von Bild und Ton bleibt, wie sie ist (`audio::lippen`,
//! `app::takt`); Plan: `intern/docs/plans/2026-10-16-bild-ton-sync-plan.md`,
//! Etappe 0b.
//!
//! **Was „Sender-Uhrzeit" heute bedeutet.** Über MediaMTX ist sie die
//! ANKUNFTSzeit am Server, je Spur aus der Mindest-Latenz geschätzt (Befund B4
//! im Plan) — die Zeile misst damit den Anteil des Players am Versatz, nicht
//! den des Senders. Den misst die Sender-Zeile `[sync]`. Auf dem Direktweg
//! (P2P zum Sidecar, ohne MediaMTX) ist es dagegen die SENDEZEIT beim Sender:
//! webrtc-rs schreibt dort die Wanduhr beim letzten Paket in den Report
//! (Befund B5). Sobald der Sender
//! seine Aufnahmezeit in die Reports schreibt und MediaMTX sie durchreicht
//! (Etappe 2/3), misst derselbe Code den ganzen Weg.
//!
//! **Was die Zeile nicht enthält:** die Latenz des Ausgabegeräts und die der
//! Anzeige. Beide sind Konstanten je Rechner und kommen erst mit Etappe 4.

use std::sync::{Arc, Mutex};
use std::time::Instant;

/// NTP-Zeitstempel (32.32-Festkomma) in Sekunden.
pub fn ntp_s(ntp: u64) -> f64 {
    (ntp >> 32) as f64 + (ntp & 0xffff_ffff) as f64 / 4_294_967_296.0
}

/// Abbildung RTP-Marke → Sender-Uhrzeit einer Spur, aus ihrem letzten Report.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SrAbbildung {
    pub ntp_s: f64,
    pub rtp: u32,
    pub takt_hz: u32,
}

impl SrAbbildung {
    pub fn aus_bericht(ntp: u64, rtp: u32, takt_hz: u32) -> Self {
        Self { ntp_s: ntp_s(ntp), rtp, takt_hz }
    }

    /// Sender-Uhrzeit einer RTP-Marke. Vorzeichenbehaftet über den Überlauf:
    /// gilt für Marken bis ±2^31 Takte um den Report (bei 90 kHz ±6 h).
    pub fn ntp_fuer(&self, rtp: u32) -> f64 {
        self.ntp_s + f64::from(rtp.wrapping_sub(self.rtp) as i32) / f64::from(self.takt_hz)
    }
}

/// Mehr Versatz als das ist keine Messung, sondern ein unpassender Report.
const PLAUSIBEL_MS: f64 = 5_000.0;

/// Versatz in ms, + heisst: der Ton hinkt hinter dem Bild.
///
/// Das Bild mit der Marke `rtp_bild` wurde um `gezeigt` zur Anzeige gestellt;
/// seine Inhaltszeit läuft danach weiter, bis das nächste kommt. Der Ton mit
/// der Marke `rtp_ton` klang um `gemessen`.
pub fn versatz_ms(
    bild: SrAbbildung,
    rtp_bild: u32,
    gezeigt: Instant,
    ton: SrAbbildung,
    rtp_ton: u32,
    gemessen: Instant,
) -> Option<f64> {
    let seit = match gemessen.checked_duration_since(gezeigt) {
        Some(d) => d.as_secs_f64(),
        None => -gezeigt.duration_since(gemessen).as_secs_f64(),
    };
    let v = (bild.ntp_fuer(rtp_bild) + seit - ton.ntp_fuer(rtp_ton)) * 1000.0;
    (v.abs() <= PLAUSIBEL_MS).then_some(v)
}

/// Letzter Report je Spur.
#[derive(Debug, Clone, Copy, Default)]
pub struct SrStand {
    pub bild: Option<SrAbbildung>,
    pub ton: Option<SrAbbildung>,
}

/// Geteilt zwischen den RTCP-Lesern der beiden Spuren (`whep.rs`) und der
/// Sitzung, die je Statistik-Takt einen Schnappschuss nimmt.
#[derive(Clone, Default)]
pub struct SrZellen(Arc<Mutex<SrStand>>);

impl SrZellen {
    /// Report ablegen. `true` beim ersten dieser Spur — der Aufrufer meldet
    /// das einmal, damit eine fehlende Zeile „Bild/Ton" erklärbar bleibt.
    pub fn bericht(&self, ist_bild: bool, ntp: u64, rtp: u32, takt_hz: u32) -> bool {
        let Ok(mut s) = self.0.lock() else { return false };
        let spur = if ist_bild { &mut s.bild } else { &mut s.ton };
        spur.replace(SrAbbildung::aus_bericht(ntp, rtp, takt_hz)).is_none()
    }

    pub fn stand(&self) -> SrStand {
        self.0.lock().map(|s| *s).unwrap_or_default()
    }
}

/// Obergrenze der gesammelten Proben. Ohne Statistik-Log ruft niemand
/// [`Versatzfenster::zeile`]; ohne Grenze wüchse das Fenster dann eine ganze
/// Sitzung lang.
pub const HOECHSTENS_PROBEN: usize = 400;

/// Sammelt Proben über ein Log-Intervall und meldet ihren Median.
#[derive(Default)]
pub struct Versatzfenster {
    proben: std::collections::VecDeque<f64>,
}

impl Versatzfenster {
    /// Eine Probe; ist das Fenster voll, fällt die älteste heraus.
    pub fn probe(&mut self, ms: f64) {
        if self.proben.len() >= HOECHSTENS_PROBEN {
            self.proben.pop_front();
        }
        self.proben.push_back(ms);
    }

    /// Die Zeile, sobald `mindestens` Proben beisammen sind — dann wird das
    /// Fenster geleert. Darunter `None`, und es sammelt weiter.
    pub fn zeile(&mut self, mindestens: usize) -> Option<String> {
        if self.proben.is_empty() || self.proben.len() < mindestens {
            return None;
        }
        let mut werte: Vec<f64> = self.proben.drain(..).collect();
        werte.sort_by(f64::total_cmp);
        let n = werte.len();
        let median = werte[n / 2];
        Some(format!(
            "Bild/Ton: Ton {median:+.0} ms hinter Bild (Median, n={n}; Bezug: Sender-Reports, ohne Geraete- und Anzeige-Latenz)"
        ))
    }
}

#[cfg(test)]
#[path = "bildton_tests.rs"]
mod tests;
