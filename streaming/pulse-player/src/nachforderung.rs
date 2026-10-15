//! Die Zellen, ueber die der NACK-Erzeuger im gepatchten webrtc-rs
//! (`patches/0002-nack-generator-resend-delay.patch`) mit der Sitzung spricht,
//! und die reine Rechnung darum.
//!
//! **Der Erzeuger misst die Antwortzeit selbst** — von der ERSTEN Anforderung
//! einer Sequenznummer bis zu ihrer Ankunft, als abklingendes Maximum
//! (Begruendung im Patch, `generator_stream.rs`). Der naheliegende Weg ueber
//! `get_stats()` funktioniert nicht: webrtc-rs deklariert
//! `current_round_trip_time`, setzt es aber fest auf 0.0
//! (`ice/src/agent/agent_stats.rs`) und berechnet es nirgends.
//!
//! Die Zellen werden je Verbindung angelegt und beim Bau der PeerConnection an
//! den Erzeuger gereicht ([`crate::whep::baue_empfaenger_pc`]).

use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

/// Ab wie vielen Messungen die Antwortzeit als belastbar gilt.
///
/// **Gewaehlt, nicht gemessen.** Eine einzelne Messung kann ein bloss
/// umsortiertes Paket sein, das ein bis zwei Millisekunden nach der ersten
/// Anforderung ohnehin eintraf; das abklingende Maximum steht dann auf diesem
/// Wert, bis die erste echte Nachlieferung kommt. Zehn Messungen machen es
/// wahrscheinlich, dass eine echte darunter ist — garantiert ist das nicht:
/// eine Strecke, auf der bisher NUR umsortiert und nie verloren wurde, liefert
/// auch zehn kleine Messungen. Dort fehlt dann zwar die Geduld, aber es gibt
/// auch nichts nachzuliefern; die erste echte Nachlieferung hebt das Maximum
/// sofort an, die Geduld folgt im naechsten Statistik-Takt (250 ms).
pub const RTT_MIN_PROBEN: u64 = 10;

/// Die Antwortzeit, wenn sie belastbar ist — sonst `None`.
///
/// Belastbar heisst: ueberhaupt gemessen und aus mindestens
/// [`RTT_MIN_PROBEN`] Messungen. Rein, damit die Grenze pruefbar bleibt.
pub fn rtt_belastbar(rtt_ms: Option<u64>, proben: u64) -> Option<u64> {
    rtt_ms.filter(|_| proben >= RTT_MIN_PROBEN)
}

/// Hoechstalter einer Nachforderung aus der laufenden Puffergeduld.
///
/// **Warum die Geduld die richtige Grenze ist.** Der Jitter-Puffer gibt eine
/// Luecke auf, wenn das erste Paket HINTER ihr `ziel` lang gewartet hat. Der
/// Erzeuger bemerkt die Luecke an genau diesem Paket und fordert in seinem
/// naechsten Takt (Vorgabe 10 ms) zum ersten Mal an. Von der ersten Anforderung bis zur Aufgabe
/// bleiben also hoechstens `ziel` Millisekunden; was danach angefordert wird,
/// kann nicht mehr rechtzeitig kommen (aus dem Code gefolgert). Die Grenze ist
/// damit eine obere: sie schneidet nie eine Anforderung ab, die noch nuetzen
/// koennte, laesst aber die letzten bis zu einer Umlaufzeit vor der Aufgabe
/// noch hinaus.
///
/// **Nie unter der Geduld des Nutzers, auch wenn die Fernsteuerung sie
/// absenkt**. Sonst schliesst sich
/// eine Schleife (Pruefung 2026-10-15): zehn kleine Messungen aus bloss
/// umsortierten Paketen gelten als belastbar, die Fern-Geduld faellt auf
/// 40 ms, das Hoechstalter mit ihr — und bei einer echten Umlaufzeit ueber
/// 40 ms kommt keine Nachlieferung mehr rechtzeitig, um gemessen zu werden.
/// Der falsche Wert stuende dann fuer immer. Mit der Geduld des Nutzers als
/// Untergrenze bleiben Antworten bis dorthin messbar; die Anforderungen
/// zwischen Fern-Geduld und Nutzer-Geduld sind der Preis dafuer.
///
/// Mindestens 1 ms: `0` hiesse im Erzeuger „keine Grenze", und eine Geduld
/// von null (Pruefstand) soll das Gegenteil bewirken.
pub fn hoechstalter_aus_geduld(ziel_ms: u64, nutzer_ms: u64) -> u64 {
    ziel_ms.max(nutzer_ms).max(1)
}

/// Die geteilten Zellen einer Verbindung. Klonen teilt sie.
#[derive(Clone)]
pub struct NackZellen {
    /// Abklingendes Maximum der Antwortzeit in ms; 0 = noch nicht gemessen.
    pub rtt_ms: Arc<AtomicU64>,
    /// Wie viele Messungen in `rtt_ms` eingegangen sind.
    pub proben: Arc<AtomicU64>,
    /// Hoechstalter einer Nachforderung in ms (s. [`hoechstalter_aus_geduld`]).
    pub hoechstalter_ms: Arc<AtomicU64>,
}

impl Default for NackZellen {
    /// Hoechstalter = Vorgabe der Puffergeduld, bis die Sitzung im ersten
    /// Statistik-Takt die tatsaechliche eintraegt.
    fn default() -> Self {
        Self {
            rtt_ms: Arc::default(),
            proben: Arc::default(),
            hoechstalter_ms: Arc::new(AtomicU64::new(u64::from(
                crate::proto::JITTER_MS_VORGABE,
            ))),
        }
    }
}

impl NackZellen {
    /// Zuletzt gemessene Antwortzeit in ms, `None` vor der ersten Messung.
    pub fn rtt_ms(&self) -> Option<u64> {
        match self.rtt_ms.load(Relaxed) {
            0 => None,
            ms => Some(ms),
        }
    }

    pub fn proben(&self) -> u64 {
        self.proben.load(Relaxed)
    }

    /// Hoechstalter an die laufende Puffergeduld koppeln. Die Sitzung ruft
    /// das im Statistik-Takt (250 ms) — eine geaenderte Geduld erreicht den
    /// Erzeuger also bis zu 250 ms spaeter.
    pub fn hoechstalter_setzen(&self, ziel_ms: u64, nutzer_ms: u64) {
        self.hoechstalter_ms.store(hoechstalter_aus_geduld(ziel_ms, nutzer_ms), Relaxed);
    }
}

impl crate::session::SessionStats {
    /// Die Log-Zeile zur Nachforderung, ohne Praefix.
    ///
    /// Eigene Zeile statt weiterer Platzhalter in der grossen Statistikzeile:
    /// die liest der Pruefstand.
    pub fn nachforderung_zeile(&self) -> String {
        let rtt = self.rtt_ms.map_or_else(|| "?".to_string(), |v| v.to_string());
        let belastbar = if rtt_belastbar(self.rtt_ms, self.rtt_proben).is_some() {
            "belastbar"
        } else {
            "nicht belastbar"
        };
        format!(
            "Nachforderung — Antwortzeit {rtt} ms aus {} Messungen ({belastbar}), \
             Puffer-Ziel {} ms, zu spaet {} (davon nach Aufgabe der Luecke {})",
            self.rtt_proben,
            self.jitter_target_ms,
            self.packets_reordered,
            self.packets_nach_aufgabe,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtt_erst_ab_genug_proben() {
        assert_eq!(rtt_belastbar(None, 100), None);
        assert_eq!(rtt_belastbar(Some(2), 1), None);
        assert_eq!(rtt_belastbar(Some(42), RTT_MIN_PROBEN - 1), None);
        assert_eq!(rtt_belastbar(Some(42), RTT_MIN_PROBEN), Some(42));
    }

    #[test]
    fn hoechstalter_folgt_der_geduld_nie_null() {
        assert_eq!(hoechstalter_aus_geduld(100, 100), 100);
        assert_eq!(hoechstalter_aus_geduld(150, 100), 150);
        assert_eq!(hoechstalter_aus_geduld(0, 0), 1);
    }

    /// Die abgesenkte Fern-Geduld zieht das Hoechstalter nicht mit herunter —
    /// sonst bliebe eine zu klein gemessene Umlaufzeit fuer immer stehen.
    #[test]
    fn hoechstalter_nie_unter_der_geduld_des_nutzers() {
        assert_eq!(hoechstalter_aus_geduld(40, 100), 100);
    }

    #[test]
    fn zellen_starten_ungemessen_mit_vorgabe_als_hoechstalter() {
        let z = NackZellen::default();
        assert_eq!(z.rtt_ms(), None);
        assert_eq!(z.proben(), 0);
        assert_eq!(z.hoechstalter_ms.load(Relaxed), u64::from(crate::proto::JITTER_MS_VORGABE));
        z.hoechstalter_setzen(0, 0);
        assert_eq!(z.hoechstalter_ms.load(Relaxed), 1);
    }
}
