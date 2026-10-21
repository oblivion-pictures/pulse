//! Die Zaehlzeilen ohne Pruefschalter (s. [`crate::messzeile`]): hier werden
//! die Staende aus Sitzung, Ausgabe-Takt und Statistik eingesammelt.
//!
//! Kindmodul von `app`, weil es die privaten Felder von [`super::Session`]
//! liest. Getrieben von den Statistik-Ereignissen der Sitzung (alle 250 ms),
//! wie `log_stats_if_due` — aber ohne dessen Schalter.

use crate::messzeile::{Bildstand, Tonstand};

use super::{App, Session};

impl App {
    /// Faellige Zaehlzeilen dieser Sitzung schreiben. `zum_schluss` =
    /// Sitzungsende: dann immer, mit dem Stand der ganzen Sitzung.
    pub(super) fn zaehlzeilen(&mut self, id: u64, zum_schluss: bool) {
        let Some(session) = self.sessions.get_mut(&id) else { return };
        let jetzt = std::time::Instant::now();
        let (bild, ton) = (bildstand(session), tonstand(session));
        if let Some(z) = session.zaehlung.bild.melden(jetzt, bild, zum_schluss) {
            eprintln!("pulse-player: Sitzung {id}: {z}");
        }
        if let Some(z) = session.zaehlung.ton.melden(jetzt, ton, zum_schluss) {
            eprintln!("pulse-player: Sitzung {id}: {z}");
        }
    }
}

fn bildstand(s: &Session) -> Bildstand {
    let st = &s.stats;
    Bildstand {
        verspaetet: s.takt.verspaetet(),
        uebersprungen: s.frames_never_drawn,
        verdraengt: s.takt.verdraengt(),
        decoder_rueckstand: st.frames_skipped,
        standluecken: s.phases.gap_late_gesamt,
        nach_paketluecke: st.frames_dropped,
        paketverlust: st.packets_lost.saturating_sub(st.packets_lost_ton),
        vorhalt_stufen: s.takt.regler_stufen(),
        betriebsart: s.takt.betriebsart(),
        vorhalt_ms: s.takt.wirksamer_vorhalt().as_millis() as u64,
    }
}

fn tonstand(s: &Session) -> Tonstand {
    let st = &s.stats;
    let m = &st.media;
    Tonstand {
        verloren: st.packets_lost_ton,
        luecken: st.ton_luecken,
        zuerst_gefehlt: st.buendel_ton.verloren,
        verdeckt: m.audio_verdeckt,
        verdeckt_plc: m.audio_verdeckt_plc,
        danach_verworfen: m.audio_ersetzt,
        unterlaeufe: m.audio_underruns,
        ton_lief: m.audio_active,
    }
}
