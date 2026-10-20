//! Zeitbasis — die Rechnung liegt seit dem 2026-08-20 gemeinsam in
//! `pulse-zeitbasis`. Dieses Modul bleibt als Re-Export bestehen, damit die
//! Aufrufstellen (`crate::zeitbasis::…`) unveraendert bleiben.

pub use pulse_zeitbasis::*;

/// Jetzt in Sekunden seit dem Bild-Ursprung, auf derselben Uhr wie die pts
/// echter Bilder — die Untergrenze für Duplikate ([`duplikat_pts`]).
///
/// Mit QPC-Sync zählen echte Bilder ab dem QPC des ersten Bildes, also hier
/// derselbe Zähler; ohne die Wanduhr ab `started`, wie dort. Nicht
/// `origin_instant`: das ist der Moment, in dem die Pipeline das erste Bild
/// ABGEHOLT hat, und liegt um dessen Zustell-Latenz neben `origin_qpc`.
pub fn jetzt_seit_ursprung(origin_qpc: Option<i64>, started: std::time::Instant) -> f64 {
    match origin_qpc {
        Some(origin) => (crate::syncprobe::qpc_now() - origin) as f64 / 10_000_000.0,
        None => started.elapsed().as_secs_f64(),
    }
}
