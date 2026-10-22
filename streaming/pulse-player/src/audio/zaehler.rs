//! Zaehlerstaende der Tonausgabe — aus `audio.rs` herausgeloest
//! (Groessengrenze, `PLAN.md` §12.1) am 2026-10-22.

use std::time::Instant;

use super::verdeckung;

/// Zaehlerstaende der Tonausgabe (s. [`super::AudioOutput::counters`]).
///
/// Benannte Felder und kein Tupel: es sind vier gleichartige Zahlen
/// hintereinander, und genau dort vertauscht irgendwann jemand zwei, ohne dass
/// es auffaellt (dieselbe Ueberlegung wie bei `session::Zeitmarken`).
#[derive(Debug, Default, Clone, Copy)]
pub struct AudioCounters {
    /// Wie oft dem Ausgabegeraet Daten fehlten.
    pub underruns: u64,
    /// Verworfene Samples (harte Ringgrenze, Rueckfuehrung und verspaeteter
    /// Ton zusammen).
    pub dropped: u64,
    /// Davon nach einem Unterlauf als verspaetet verworfen (s.
    /// `audio::nachzuegler`).
    pub verspaetet: u64,
    /// Aktueller Fuellstand des Rings in Samples.
    pub buffered: usize,
    /// Grobkappungen der Rueckfuehrung (s. `audio::ringregelung`).
    pub resyncs: u64,
    /// Aktuelle Nachfuehrung der Abspielrate in Millionstel (s.
    /// `audio::uhrenabgleich`). Steht im Protokoll, weil ein Eingriff, den
    /// niemand sieht, genau die Sorte Fehler ist, die hier behoben wurde.
    pub abgleich_ppm: i32,
    /// Ob der Ausgabe-Thread noch laeuft.
    pub alive: bool,
    /// Ob der Ausgabegeraet-Fehlerzustand gesetzt ist (s. `Shared::geraetefehler`).
    pub geraetefehler: bool,
    /// Zuletzt gemessener Lippenfehler in ms (positiv = Ton haengt hinterher,
    /// s. `audio::lippen`). 0 solange keine Vermessung laeuft.
    pub lippen_ms: f32,
    /// Welche Ton-RTP-Marke zuletzt klang, und wann (s. [`crate::bildton`]).
    pub klingt: Option<(u32, Instant)>,
    /// Regel-Eingriff der Lippen-Synchronisation auf den Ring-Sollwert in ms.
    pub sync_versatz_ms: i32,
    /// Verdeckte Verluste (s. `audio::verdeckung`).
    pub verdeckung: verdeckung::Zaehler,
    /// Verzoegerung vom Geraete-Abruf bis zum Lautsprecher in ms, wie die
    /// Anbindung sie meldet. Steckt NICHT in der Bild/Ton-Messung
    /// (`crate::bildton`) — deshalb gehoert sie daneben ins Protokoll.
    pub ausgabe_ms: Option<f32>,
    /// Ueber welchen Weg der Ton hinausgeht (s. `AudioOutput::weg`).
    pub weg: &'static str,
}
