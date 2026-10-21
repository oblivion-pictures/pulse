//! Der Haken „Bild sofort zeigen" im Fern-Menue.
//!
//! Eigene Datei aus demselben Grund wie [`super::ablageschalter`]:
//! `fernbedienung.rs` liegt an der Groessen-Grenze (`PLAN.md` §12.1).
//!
//! **Was der Haken bedeutet, entscheidet nicht das Fenster.** Er meldet nur
//! [`OverlayAction::FernSofort`]; die beiden Betriebsarten und ihre Begruendung
//! stehen in `app::takt::fernsteuerung`, das Umschalten aller Fenster und das
//! Merken in `app::sofortbild`.

use super::{Overlay, OverlayAction};
use crate::theme;

impl Overlay {
    /// Eine Zeile mit Haken. Nur im Fern-Menue, also nur waehrend einer
    /// Fernsteuerung — beim Zusehen gibt es nichts umzuschalten.
    pub(super) fn sofort_schalter(&mut self, ui: &mut egui::Ui, actions: &mut Vec<OverlayAction>) {
        ui.add_space(6.0);
        let mut an = self.fern_sofort;
        let antwort = ui.checkbox(
            &mut an,
            egui::RichText::new("Bild sofort zeigen").font(theme::font_xs()).color(theme::TEXT),
        );
        if antwort.changed() {
            // **Nicht selbst umlegen** — wie beim Ablage-Schalter: der Stand
            // kommt aus der App zurueck (`set_fern_sofort`), damit alle Fenster
            // dasselbe zeigen.
            actions.push(OverlayAction::FernSofort(an));
        }
        antwort.on_hover_text(
            "An: jedes Bild erscheint, sobald es da ist — geringste Verzögerung. \
             Aus: eine kleine Reserve glättet das Bild und kostet etwas Verzögerung.",
        );
    }

    /// Den Stand des Hakens nachziehen. **Die App ist die Quelle** — sie
    /// fuehrt den Wert fuer den ganzen Prozess (`app::sofortbild`).
    pub fn set_fern_sofort(&mut self, an: bool) {
        if self.fern_sofort == an {
            return;
        }
        self.fern_sofort = an;
        self.input_pending = true;
    }
}
