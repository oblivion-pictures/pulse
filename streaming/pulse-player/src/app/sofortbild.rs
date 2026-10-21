//! Der Haken „Bild sofort zeigen" auf Seite der App: EIN Wert fuer den ganzen
//! Prozess, gemerkt ueber Sitzungen hinweg.
//!
//! **Warum prozessweit und nicht je Sitzung.** Mehrere Bildschirme desselben
//! fernen Rechners laufen als mehrere Sitzungen in diesem Prozess; liefen sie
//! verschieden schnell, saehe man denselben Mauszug auf zwei Schirmen
//! zeitversetzt. Und der Haken ist eine Vorliebe fuer die eigene Leitung, kein
//! Merkmal eines einzelnen Streams.
//!
//! **Wie er gemerkt wird.** Der Startwert kommt aus `PULSE_PLAYER_FERN_SOFORT`
//! (`takt::fern_sofort_aus_umgebung`); die Desktop-App setzt die Variable beim
//! Start des Players aus ihrem Store und schreibt den Store, wenn hier
//! umgeschaltet wird (`player:fernSofort`, `desktop/electron/player.ts`).
//! Dasselbe Muster wie `recordingDir`: eine Einstellung, die nur der
//! Hauptprozess liest, ohne Umweg ueber den Renderer.
//!
//! Was die beiden Betriebsarten bedeuten, steht in `takt::fernsteuerung`.

use crate::proto::Event;

use super::App;

impl App {
    /// Den Haken fuer alle Fenster umlegen — wirkt sofort in einer laufenden
    /// Fernsteuerung (s. `Ausgabetakt::fern_sofort_setzen`).
    pub(super) fn fern_sofort_setzen(&mut self, an: bool) {
        if self.fern_sofort != an {
            self.fern_sofort = an;
            // Einmal je Wechsel ins Log: die Zaehlzeile nennt nur den Stand,
            // nicht wann er wechselte.
            eprintln!(
                "pulse-player: Fernsteuerung — Bild sofort zeigen {}",
                if an { "an" } else { "aus" }
            );
            // Nach vorne melden, damit die App den Wert behaelt (s. Modulkopf).
            self.stdout.send(&Event::new("player:fernSofort", serde_json::json!({ "an": an })));
        }
        // Auch ohne Wechsel nachziehen: ein Fenster, dessen Haken nicht zum
        // Prozess passt, soll beim naechsten Klick richtig stehen.
        for session in self.sessions.values_mut() {
            session.takt.fern_sofort_setzen(an);
            if let Some(overlay) = session.overlay.as_mut() {
                overlay.set_fern_sofort(an);
            }
            session.window.request_redraw();
        }
    }
}
