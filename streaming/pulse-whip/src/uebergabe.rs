//! Wie lange nach ihrer Aufnahme Bild und Ton den Sender verlassen — je Spur,
//! über ein festes Fenster, als eine Logzeile.
//!
//! **Warum das die Frage nach dem Bild/Ton-Versatz beantwortet.** Kein
//! Zuschauer kennt heute die Aufnahmezeit des Tons: MediaMTX stempelt die
//! Opus-Zeitstempel nach Paketzahl neu und schätzt die Wanduhrzeit seiner
//! Sender Reports je Spur aus der ANKUNFT, verankert an der Mindest-Latenz
//! (Befunde B3/B4 im Plan `intern/docs/plans/2026-10-16-bild-ton-sync-plan.md`).
//! Jede Spur bekommt damit „Aufnahme + ihre kleinste Übergabe-Latenz" als
//! Uhrzeit, und der Zuschauer richtet beide danach aus. Verlässt der Ton den
//! Sender später nach seiner Aufnahme als das Bild, klingt er beim Zuschauer
//! um genau diese Differenz zu spät.
//!
//! **Deshalb steht das MINIMUM in der Zeile, nicht nur der Median**: an ihm
//! verankert MediaMTX. Der Median sagt, wie es meistens ist; das Minimum, was
//! der Zuschauer daraus macht. Die Netzstrecke zum Server fehlt beiden — sie
//! ist für beide Spuren dieselbe Leitung.
//!
//! **Lücken der Ton-Zeitlinie** zählen mit, weil MediaMTX sie nicht sieht: der
//! Sender rechnet einen PTS-Sprung in den RTP-Zeitstempel ein
//! (`senke_writer::ton_dauer_aus_pts` unter Windows), MediaMTX zählt danach
//! nur Pakete. Jede Lücke fehlt dort der Tonuhr.
//!
//! Reine Rechnung ohne Plattformbezug — sie liegt hier und nicht im
//! Windows-Sidecar, weil dessen Tests in keinem Gate laufen.

use std::time::{Duration, Instant};

/// Min, Median und 95. Perzentil einer Messreihe in Millisekunden.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Kennzahlen {
    pub min: f64,
    pub p50: f64,
    pub p95: f64,
    pub n: usize,
}

/// Kennzahlen nach dem Verfahren „nächster Rang" (`werte` wird sortiert).
/// `None` für eine leere Reihe.
pub fn kennzahlen(werte: &mut [f64]) -> Option<Kennzahlen> {
    if werte.is_empty() {
        return None;
    }
    werte.sort_by(f64::total_cmp);
    let n = werte.len();
    let rang = |q: f64| werte[((q * n as f64).ceil() as usize).clamp(1, n) - 1];
    Some(Kennzahlen { min: werte[0], p50: rang(0.5), p95: rang(0.95), n })
}

/// Alter eines Pakets bei der Übergabe in ms: `jetzt` minus Aufnahmezeit
/// (`ursprung` + `takte` / `takt_hz`). Negativ, wenn der Zeitstempel vor der
/// Uhr liegt — bei duplizierten Bildern kommt er aus einem Zähler.
pub fn alter_ms(ursprung: Instant, takte: i64, takt_hz: u32, jetzt: Instant) -> f64 {
    let seit_ursprung = match jetzt.checked_duration_since(ursprung) {
        Some(d) => d.as_secs_f64(),
        None => -ursprung.duration_since(jetzt).as_secs_f64(),
    };
    (seit_ursprung - takte as f64 / f64::from(takt_hz)) * 1000.0
}

/// Sammelt Übergabe-Latenzen beider Spuren und gibt je Fenster eine Zeile aus.
pub struct Uebergabefenster {
    laenge: Duration,
    beginn: Option<Instant>,
    bild: Vec<f64>,
    ton: Vec<f64>,
    luecken: u32,
    luecken_ms: u64,
}

impl Uebergabefenster {
    pub fn neu(laenge: Duration) -> Self {
        Self { laenge, beginn: None, bild: Vec::new(), ton: Vec::new(), luecken: 0, luecken_ms: 0 }
    }

    /// Ein Bild hat den Sender `ms` nach seiner Aufnahme verlassen.
    pub fn bild(&mut self, ms: f64, jetzt: Instant) {
        self.beginn.get_or_insert(jetzt);
        self.bild.push(ms);
    }

    /// Ein Tonpaket hat den Sender `ms` nach seiner Aufnahme verlassen.
    pub fn ton(&mut self, ms: f64, jetzt: Instant) {
        self.beginn.get_or_insert(jetzt);
        self.ton.push(ms);
    }

    /// Die Ton-Zeitlinie ist um mehr als eine Rahmenlänge gesprungen.
    pub fn ton_luecke(&mut self, ms: u64) {
        self.luecken += 1;
        self.luecken_ms += ms;
    }

    /// Die Zeile, sobald das Fenster abgelaufen ist — danach beginnt es leer.
    pub fn faellig(&mut self, jetzt: Instant) -> Option<String> {
        let beginn = self.beginn?;
        if jetzt.saturating_duration_since(beginn) < self.laenge {
            return None;
        }
        let bild = kennzahlen(&mut self.bild);
        let ton = kennzahlen(&mut self.ton);
        let mut zeile = format!(
            "[sync] Uebergabe seit Aufnahme ({} s): Bild {}, Ton {}",
            self.laenge.as_secs(),
            spur(bild),
            spur(ton)
        );
        if let (Some(b), Some(t)) = (bild, ton) {
            zeile += &format!(
                " -> Ton-Bild min {:+.1} ms, p50 {:+.1} ms",
                t.min - b.min,
                t.p50 - b.p50
            );
        }
        zeile += &format!("; Ton-Luecken {} ({} ms)", self.luecken, self.luecken_ms);
        *self = Self::neu(self.laenge);
        Some(zeile)
    }
}

fn spur(k: Option<Kennzahlen>) -> String {
    match k {
        Some(k) => format!("min {:.1}/p50 {:.1}/p95 {:.1} ms (n={})", k.min, k.p50, k.p95, k.n),
        None => "-".to_owned(),
    }
}

#[cfg(test)]
#[path = "uebergabe_tests.rs"]
mod tests;
