//! Der **Bildplatz**: wann der nächste Tick des festen Rasters fällig ist.
//!
//! Das Raster läuft unabhängig davon, ob ein Bild angekommen ist — es ist die
//! Glättung, für die der Pacing-Loop da ist (Begründung am Frame-Pacing in
//! [`super::run`]). Herausgezogen in ein Modul, das ausser der Uhr nichts
//! kennt — kein Windows, kein Capture, kein Encoder —, damit die Kadenz einen
//! Test bekommen kann.
//!
//! **Bis zum 2026-10-31 stand hier mehr:** eine Vergabe nach dem Senden und
//! eine Bremse „höchstens ein Bild je Bildabstand" für das Senden bei Ankunft
//! während einer Fernsteuerung (eingeführt 2026-08-13, Fehler „die 60 fps
//! kommen nie an" behoben 2026-08-22). Eigentümer-Entscheid: während einer
//! Fernsteuerung wird genau so gestreamt wie sonst; der Weg ist entfernt,
//! seine Herleitung steht in der Git-Historie dieser Datei.

use std::time::{Duration, Instant};

/// Der nächste Tick des Rasters.
pub(super) struct Bildplatz {
    faellig: Instant,
    frame_dur: Duration,
}

impl Bildplatz {
    pub(super) fn neu(start: Instant, fps: u32) -> Self {
        Self { faellig: start, frame_dur: Duration::from_secs_f64(1.0 / f64::from(fps.max(1))) }
    }

    /// Wann der nächste Tick fällig ist.
    pub(super) fn faellig(&self) -> Instant {
        self.faellig
    }

    /// Das feste Raster läuft weiter, unabhängig davon, ob etwas angekommen
    /// ist — es ist genau die Glättung, für die es da ist.
    ///
    /// Der Rückstand wird nicht angehäuft (sonst Bilder-Schwall nach einem
    /// Stocken).
    pub(super) fn weiter_im_raster(&mut self, jetzt: Instant) {
        self.faellig += self.frame_dur;
        if self.faellig < jetzt {
            self.faellig = jetzt;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Tick je Bildabstand, unabhängig von den Ankünften.
    #[test]
    fn raster_laeuft_unabhaengig_von_ankuenften() {
        let start = Instant::now();
        let mut platz = Bildplatz::neu(start, 60);
        let frame_dur = Duration::from_secs_f64(1.0 / 60.0);
        for i in 1..=600u32 {
            platz.weiter_im_raster(start);
            assert_eq!(platz.faellig(), start + frame_dur * i);
        }
    }

    /// Ein Rückstand (langsamer Encode-Durchlauf) wird nicht nachgeholt —
    /// sonst folgte ein Schwall.
    #[test]
    fn raster_holt_rueckstand_nicht_nach() {
        let start = Instant::now();
        let mut platz = Bildplatz::neu(start, 60);
        let spaet = start + Duration::from_millis(500);
        platz.weiter_im_raster(spaet);
        assert_eq!(platz.faellig(), spaet);
    }
}
