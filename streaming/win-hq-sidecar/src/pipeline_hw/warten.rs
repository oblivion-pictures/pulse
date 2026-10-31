//! Die Wartephase des Pacing-Loops: bis zum Tick schlafen, danach die
//! Capture-Queue leeren.
//!
//! Herausgelöst aus `mod.rs`, weil die Datei zum zweiten Mal über die harte
//! 500-Zeilen-Grenze gewachsen war (PLAN.md §12.1) — ihr Modulkopf begründet
//! schon die erste Auslagerung (`capture_start`) genau so. Die Messpunkte
//! (`geplant`/`iter_start`/`capture_drain`) werden HIER gesetzt und
//! unverändert zurückgegeben, damit der `TickMonitor` in `mod.rs` dieselben
//! Größen sieht wie vor dem Umzug.
//!
//! Bis zum 2026-10-31 gab es daneben eine zweite Wartart nur für die
//! Fernsteuerung (auf die Ankunft des nächsten Bildes warten statt auf den
//! Tick, Schalter `PULSE_HQ_FERN_TICKRASTER`). Eigentümer-Entscheid: während
//! einer Fernsteuerung wird genau so gestreamt wie sonst, der Zweig ist weg.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};

use super::bildplatz::Bildplatz;
use crate::capture::{HwCaptureItem, WgcHwCapture};
use crate::encode::OwnedHwFrame;

/// Der Capture-Kanal ist mitten im Stream tot — die Fehlermeldung dazu.
///
/// Ohne den echten Worker-Fehler aus `join_error` bliebe nur „channel
/// disconnected", und die eigentliche Ursache (WGC-Close ohne Frame,
/// Pool-Fehler, …) ginge verloren.
fn kanal_tot(capture: &mut WgcHwCapture) -> anyhow::Error {
    let worker_err = capture.join_error();
    anyhow!(
        "hw capture channel disconnected mid-stream{}",
        crate::capture::worker_err_suffix(worker_err, "clean exit, keine Fehlermeldung")
    )
}

/// Ergebnis einer Wartephase — die Zähler und Messpunkte, die der
/// Tick-Monitor in `mod.rs` weiterverbucht.
pub(super) struct Abholung {
    /// Wieviele Bilder der Drain gebracht hat; `0` heißt „Quelle unverändert"
    /// und steuert die Duplizierung.
    pub captured: u32,
    /// Der geplante Termin — `wake_jitter` wird dagegen gemessen.
    pub geplant: Instant,
    /// Der echte Wieder-Aufwach-Zeitpunkt — ab hier zählt die Arbeitszeit.
    pub iter_start: Instant,
    pub capture_drain: Duration,
}

/// Eine Wartephase fahren: bis zum nächsten Tick schlafen — das feste Raster
/// glättet, und genau dafür ist es da. `thread::sleep` nutzt auf
/// Win10+/aktuellem Rust einen High-Resolution-Waitable-Timer. Das Raster
/// läuft danach weiter, egal ob etwas angekommen ist ([`Bildplatz`]).
///
/// Danach werden alle noch wartenden Capture-Frames abgeholt, nur der neueste
/// bleibt in `last_frame` (ältere gehen in den Pool zurück). Kommt nichts
/// Neues, bleibt `last_frame` erhalten = Duplizierung bei statischem Bild.
pub(super) fn warten_und_abholen(
    capture: &mut WgcHwCapture,
    platz: &mut Bildplatz,
    last_frame: &mut Option<OwnedHwFrame>,
    newest_qpc: &mut i64,
) -> Result<Abholung> {
    let geplant = platz.faellig();
    let now = Instant::now();
    if geplant > now {
        std::thread::sleep(geplant - now);
    }
    platz.weiter_im_raster(Instant::now());

    // Ab hier wird Arbeit gemessen (ohne den Pacing-Sleep) — derselbe
    // Zeitpunkt trägt den Iterationsbeginn und den Anfang des Drains.
    let iter_start = Instant::now();
    let mut captured: u32 = 0;
    loop {
        match capture.items.try_recv() {
            Ok(HwCaptureItem::Frame { frame, qpc }) => {
                // Das vorige Bild geht dabei in den Pool zurück; nur der
                // neueste QPC-Zeitstempel bleibt (`0` heißt „nicht
                // verfügbar" und überschreibt den letzten gültigen nicht).
                *last_frame = Some(frame);
                if qpc != 0 {
                    *newest_qpc = qpc;
                }
                captured += 1;
            }
            Ok(HwCaptureItem::Setup { .. }) => {
                return Err(anyhow!("unexpected Setup item after pipeline init"));
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => break,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return Err(kanal_tot(capture));
            }
        }
    }
    Ok(Abholung { captured, geplant, iter_start, capture_drain: iter_start.elapsed() })
}
