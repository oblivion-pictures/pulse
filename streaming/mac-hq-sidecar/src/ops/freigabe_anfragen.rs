//! `freigabe_anfragen` — die naechste fehlende Systemfreigabe der
//! Fernsteuerung anfragen (Bedienungshilfen, dann Eingabeueberwachung).
//!
//! **Zeigt einen Systemdialog** und kommt deshalb nur auf Nutzerklick: Knopf
//! „Freigabe anfordern" im Panel „Remote-Rechner"
//! (`web/src/lib/components/settings/SettingsStandplatzBerechtigung.svelte`).
//! Bis zum 2026-10-19 fragte niemand je an — Pulse erschien nie von selbst in
//! den Listen der Systemeinstellungen.
//!
//! Antwort wie `health.sidecar` fuer die Fernsteuerung, dazu `angefragt`:
//!
//! ```jsonc
//! {"ok": true, "angefragt": "bedienungshilfen" | "eingabeueberwachung" | "",
//!  "remote_input": false, "remote_input_grund": "bedienungshilfen"}
//! ```
//!
//! `remote_input` ist der Stand **direkt nach** der Anfrage — der Nutzer hat
//! den Dialog dann meist noch nicht beantwortet. Die Oberflaeche misst deshalb
//! bei der Rueckkehr ins Fenster erneut (`pruefeGesundheitErneut`).

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::berechtigung::{self, Anfrage};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let angefragt = berechtigung::anfragen();
    let (fernsteuerbar, grund) =
        berechtigung::faehigkeit(berechtigung::darf_einspielen(), berechtigung::mithoeren_stand());
    Ok(antwort(angefragt, fernsteuerbar, grund))
}

/// Die Antwort, getrennt von den FFI-Aufrufen — sonst liesse sich das Gerüst
/// nur pruefen, indem man auf dem Entwicklerrechner einen Dialog aufwirft.
fn antwort(angefragt: Option<Anfrage>, fernsteuerbar: bool, grund: String) -> Map<String, Value> {
    match json!({
        "angefragt": angefragt.map_or("", Anfrage::name),
        "remote_input": fernsteuerbar,
        "remote_input_grund": grund,
    }) {
        Value::Object(m) => m,
        _ => unreachable!("json!({{…}}) ist immer ein Objekt"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antwort_traegt_anfrage_und_stand() {
        let a = antwort(Some(Anfrage::Bedienungshilfen), false, "bedienungshilfen".into());
        assert_eq!(a["angefragt"], "bedienungshilfen");
        assert_eq!(a["remote_input"], false);
        assert_eq!(a["remote_input_grund"], "bedienungshilfen");
    }

    /// Nichts mehr anzufragen (alles erteilt oder nach einem Nein) heisst
    /// leerer String, nicht `null` — die Oberflaeche vergleicht mit Text.
    #[test]
    fn ohne_anfrage_leer_statt_null() {
        let a = antwort(None, true, String::new());
        assert_eq!(a["angefragt"], "");
        assert_eq!(a["remote_input"], true);
    }
}
