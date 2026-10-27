//! Versatz echte Aufnahmezeit minus gezählter pts — die Marke der Tonspur auf
//! dem Sendeweg ohne Container (WHIP, Direktweg). Ohne Windows- und
//! FFmpeg-Bezug, damit unter Linux prüfbar.
//!
//! **Warum.** Der Ton-pts zählt Samples, damit die Opus-Zeitlinie (und auf
//! dem Muxer-Weg die FLV-Spur) lückenlos bleibt. Die Senderberichte tragen
//! aber Aufnahmezeiten (`pulse_whip::senderbericht`), und das Bild stempelt
//! mit dem WGC-Stempel. Gemessen am 2026-10-27 (`[sync]`, all3media, GTX
//! 1070): der gezählte Ton-pts lag bei der Übergabe 12–30 ms VOR der Uhr, das
//! Bild 21 ms dahinter — der Zuschauer spielte den Ton entsprechend zu spät.
//! Linux und macOS senden längst pts + Versatz (`linux-hq-sidecar`,
//! `encode/audio.rs`, Feld `versatz`); dies ist das Gegenstück für Windows,
//! gespeist aus [`crate::audio::aufnahmebuch`].
//!
//! **Plausibilitätsgrenze.** Weicht die Aufnahmezeit mehr als 1 s von der
//! Zählung ab, ist der Stempel kaputt (Gerät liefert Unsinn, Epochensprung)
//! und nicht der Ton: dann gilt der gezählte pts wie bis 0.1.139, einmal
//! geloggt, je Fenster mitgezählt.

use std::time::{Duration, Instant};

/// Sammelt den Versatz je Chunk und gibt alle `laenge` eine Logzeile aus.
pub struct Versatzbuch {
    rate: u32,
    laenge: Duration,
    /// Zuletzt gemessener Versatz in Samples (0 = gezählter pts gilt).
    versatz: i64,
    beginn: Option<Instant>,
    /// Versatz der Chunks mit Gerätestempel in ms (nur fürs Fenster).
    geraet: Vec<f64>,
    stille: u32,
    ohne: u32,
    rueckfaelle: u32,
    rueckfall_gemeldet: bool,
}

impl Versatzbuch {
    pub fn neu(rate: u32, laenge: Duration) -> Self {
        Self {
            rate: rate.max(1),
            laenge,
            versatz: 0,
            beginn: None,
            geraet: Vec::new(),
            stille: 0,
            ohne: 0,
            rueckfaelle: 0,
            rueckfall_gemeldet: false,
        }
    }

    /// Versatz in Samples, um den die Marke des nächsten Pakets vom gezählten
    /// pts abweicht.
    pub fn versatz(&self) -> i64 {
        self.versatz
    }

    /// Ein Chunk geht in den Encoder. `echt` = Aufnahmezeit seines ersten
    /// Samples in Samples ab dem gemeinsamen Ursprung, Trim schon eingerechnet
    /// (`None` = unbekannt); `gezaehlt` = wo dasselbe Sample auf der gezählten
    /// pts-Zeitlinie steht (pts + was noch im Sammelpuffer liegt).
    /// Liefert beim ERSTEN Rückfall eine Logzeile.
    pub fn messen(
        &mut self,
        echt: Option<i64>,
        aus_geraet: bool,
        gezaehlt: i64,
        jetzt: Instant,
    ) -> Option<String> {
        self.beginn.get_or_insert(jetzt);
        let Some(echt) = echt else {
            self.ohne += 1;
            self.versatz = 0;
            return None;
        };
        let v = echt - gezaehlt;
        if v.abs() > i64::from(self.rate) {
            self.rueckfaelle += 1;
            self.versatz = 0;
            if self.rueckfall_gemeldet {
                return None;
            }
            self.rueckfall_gemeldet = true;
            return Some(format!(
                "[audio] Aufnahmezeit weicht {:+.0} ms von der Zaehlung ab — unplausibel, \
                 Ton-Marke faellt auf den gezaehlten pts zurueck (weitere Faelle nur in der \
                 Aufnahmezeit-Zeile)",
                self.ms(v)
            ));
        }
        self.versatz = v;
        if aus_geraet {
            self.geraet.push(self.ms(v));
        } else {
            self.stille += 1;
        }
        None
    }

    /// Die Logzeile, sobald das Fenster abgelaufen ist — danach beginnt es leer.
    pub fn faellig(&mut self, jetzt: Instant) -> Option<String> {
        let beginn = self.beginn?;
        if jetzt.saturating_duration_since(beginn) < self.laenge {
            return None;
        }
        let werte = &mut self.geraet;
        let geraet = if werte.is_empty() {
            "-".to_owned()
        } else {
            werte.sort_by(f64::total_cmp);
            let p50 = werte[(werte.len() - 1) / 2];
            format!(
                "p50 {p50:+.1} / min {:+.1} / max {:+.1} ms (n={})",
                werte[0],
                werte[werte.len() - 1],
                werte.len()
            )
        };
        let zeile = format!(
            "[audio] Aufnahmezeit ({} s): Versatz Geraet−Zaehlung {geraet}; Stille-Chunks {}, \
             ohne Stempel {}, Rueckfall >1 s {}",
            self.laenge.as_secs(),
            self.stille,
            self.ohne,
            self.rueckfaelle
        );
        self.beginn = None;
        self.geraet.clear();
        (self.stille, self.ohne, self.rueckfaelle) = (0, 0, 0);
        Some(zeile)
    }

    fn ms(&self, samples: i64) -> f64 {
        samples as f64 * 1000.0 / f64::from(self.rate)
    }
}

#[cfg(test)]
#[path = "versatz_tests.rs"]
mod tests;
