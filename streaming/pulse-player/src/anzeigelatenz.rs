//! Anzeige-Latenz: vom Uebernehmen eines Bildes (`App::uebernehmen` stempelt
//! dort `gezeigt`) bis es auf dem Schirm steht — die Bild-Seite der Zeile
//! „Bild/Ton" und der gemeinsamen Uhr (seit 2026-10-27, `crate::bildton`).
//!
//! **Zwei Teile, einer gemessen, einer GESCHAETZT.**
//! * Zeichnen: Hochladen plus Darstellen bis nach `queue.present` — das Mittel
//!   der letzten Sekunde aus `PhaseTimes` (gemessen). Nicht darin: die Zeit
//!   von `request_redraw` bis zum Zeichenaufruf und der Abschnitt zwischen
//!   Hochladen und Darstellen (`diagnose::ZWISCHEN_*`), beide klein.
//! * Bildschirm: von `present` bis das Bild sichtbar wird — **geschaetzt**
//!   aus Ausgabe-Takt und Wiederholrate ([`schirm_takte`]).
//!
//! **Warum geschaetzt — was die Bibliotheken hergeben** (nachgesehen am
//! 2026-10-27 in den Quellen von wgpu 30.0.0, winit 0.30.13,
//! wayland-protocols 0.32.13):
//! * wgpu hat keinen Zeitstempel je ausgegebenem Bild.
//!   `Adapter::get_presentation_timestamp` rechnet nur Uhren um;
//!   `Features::VULKAN_GOOGLE_DISPLAY_TIMING` schaltet die Erweiterung bloss
//!   frei („does not have a wgpu-level API", nur ueber `as_hal`, laut
//!   wgpu-Doku „generally only available on Android"). D3D12
//!   (`GetFrameStatistics`) und Metal (`addPresentedHandler`) ebenfalls nur
//!   ueber `as_hal` — nicht gebaut.
//! * winit liefert die Wiederholrate (`MonitorHandle::refresh_rate_millihertz`),
//!   sonst nichts zur Ausgabe.
//! * Wayland: `wp_presentation` (Rueckmeldung „presented" mit Zeitstempel)
//!   steckt in `wayland-protocols` 0.32 (`wp::presentation_time`), also OHNE
//!   neue Abhaengigkeit erreichbar. Nicht gebaut: die Rueckmeldung muss VOR dem
//!   `wl_surface.commit` angefordert werden, und den schickt der Vulkan-Treiber
//!   in `queue.present` selbst — ob die Reihenfolge auf derselben Verbindung
//!   unter NVIDIA und Mesa traegt, ist nur am laufenden Fenster pruefbar.
//!   Eigener Schritt, dann ersetzt der Messwert [`schirm_takte`].
//!
//! **Nicht enthalten**, auch nicht geschaetzt: der eigene Takt des Compositors
//! (er kann ein Bild zusaetzlich halten), die Zeit, bis der Strahl die
//! Bildmitte erreicht (im Mittel ein halber Takt), und der Eingangsverzug des
//! Monitors. Die Zahl ist also eher zu klein.

use std::time::Duration;

/// Angenommene Wiederholrate, wenn winit keine meldet.
const HZ_VORGABE: f64 = 60.0;

/// Bildschirm-Anteil in Takten der Wiederholrate, je Ausgabe-Takt.
///
/// * `Mailbox`: `present` kehrt sofort zurueck, an der naechsten Wiederholung
///   wird das juengste Bild genommen — die Wartezeit liegt gleichverteilt
///   zwischen null und einem Takt, im Mittel ein halber.
/// * `Fifo`: das Bild reiht sich in die Warteschlange und kommt fruehestens an
///   der naechsten Wiederholung, bei schon wartendem Vorgaenger eine spaeter —
///   ein Takt als runde Mitte.
/// * `Immediate`: kein Warten, aber das neue Bild erscheint ab der aktuellen
///   Zeile — bis es den mittleren Bildpunkt erreicht, im Mittel ein halber.
/// * Unbekannt (kein Renderer): ein Takt.
pub fn schirm_takte(art: Option<wgpu::PresentMode>) -> f64 {
    use wgpu::PresentMode as P;
    match art {
        Some(P::Mailbox | P::Immediate | P::AutoNoVsync) => 0.5,
        Some(P::Fifo | P::FifoRelaxed | P::AutoVsync) | None => 1.0,
    }
}

/// Anzeige-Latenz eines Fensters, wie sie in die Bild/Ton-Messung eingeht.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anzeige {
    /// Gemessen: Mittel Hochladen + Darstellen in ms.
    pub zeichnen_ms: f64,
    /// GESCHAETZT: von `present` bis sichtbar, in ms.
    pub schirm_ms: f64,
    art: Option<wgpu::PresentMode>,
    /// Wiederholrate; `None` = nicht gemeldet, [`HZ_VORGABE`] angenommen.
    hz: Option<f64>,
}

impl Anzeige {
    /// `zeichnen_us` = Mittel Hochladen + Darstellen (`PhaseTimes`),
    /// `wiederhol_mhz` = Wiederholrate in Millihertz (winit).
    pub fn schaetzen(
        zeichnen_us: u64,
        art: Option<wgpu::PresentMode>,
        wiederhol_mhz: Option<u32>,
    ) -> Self {
        let hz = wiederhol_mhz.filter(|m| *m > 0).map(|m| f64::from(m) / 1000.0);
        let takt_ms = 1000.0 / hz.unwrap_or(HZ_VORGABE);
        Self {
            zeichnen_ms: zeichnen_us as f64 / 1000.0,
            schirm_ms: schirm_takte(art) * takt_ms,
            art,
            hz,
        }
    }

    pub fn gesamt_ms(&self) -> f64 {
        self.zeichnen_ms + self.schirm_ms
    }

    pub fn dauer(&self) -> Duration {
        Duration::from_secs_f64(self.gesamt_ms().max(0.0) / 1000.0)
    }

    /// Fuer die Zeile „Bild/Ton": was gemessen und was geschaetzt ist.
    pub fn beschreibung(&self) -> String {
        let art = self.art.map_or_else(|| "Ausgabe-Takt unbekannt".into(), |a| format!("{a:?}"));
        let hz = match self.hz {
            Some(hz) => format!("{hz:.0} Hz"),
            None => format!("{HZ_VORGABE:.0} Hz angenommen"),
        };
        format!(
            "Anzeige {:.1} ms = Zeichnen {:.1} ms gemessen + Bildschirm {:.1} ms GESCHAETZT \
             ({art}, {} Takt bei {hz})",
            self.gesamt_ms(),
            self.zeichnen_ms,
            self.schirm_ms,
            if schirm_takte(self.art) < 1.0 { "1/2" } else { "1" },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgpu::PresentMode as P;

    /// Mailbox: halber Takt, Fifo: ein Takt — bei 60 Hz 8,3 bzw. 16,7 ms, bei
    /// 144 Hz 3,5 ms; das Zeichnen kommt obendrauf.
    #[test]
    fn schaetzung_je_ausgabe_takt_und_rate() {
        let m = Anzeige::schaetzen(2_000, Some(P::Mailbox), Some(60_000));
        assert!((m.schirm_ms - 8.333).abs() < 0.01, "{}", m.schirm_ms);
        assert!((m.gesamt_ms() - 10.333).abs() < 0.01, "{}", m.gesamt_ms());
        let f = Anzeige::schaetzen(0, Some(P::Fifo), Some(60_000));
        assert!((f.schirm_ms - 16.667).abs() < 0.01, "{}", f.schirm_ms);
        let schnell = Anzeige::schaetzen(0, Some(P::Mailbox), Some(144_000));
        assert!((schnell.schirm_ms - 3.472).abs() < 0.01, "{}", schnell.schirm_ms);
    }

    /// Ohne gemeldete Rate gelten 60 Hz — und die Zeile sagt das.
    #[test]
    fn ohne_rate_sechzig_hz_angenommen() {
        let a = Anzeige::schaetzen(0, Some(P::Mailbox), None);
        assert!((a.schirm_ms - 8.333).abs() < 0.01);
        assert!(a.beschreibung().contains("60 Hz angenommen"), "{}", a.beschreibung());
        assert_eq!(Anzeige::schaetzen(0, Some(P::Mailbox), Some(0)).schirm_ms, a.schirm_ms);
    }

    /// Die Zeile trennt gemessen und GESCHAETZT.
    #[test]
    fn beschreibung_kennzeichnet_die_schaetzung() {
        let z = Anzeige::schaetzen(2_100, Some(P::Mailbox), Some(59_951)).beschreibung();
        assert!(z.contains("Zeichnen 2.1 ms gemessen"), "{z}");
        assert!(z.contains("Bildschirm 8.3 ms GESCHAETZT (Mailbox, 1/2 Takt bei 60 Hz)"), "{z}");
        assert_eq!(Anzeige::schaetzen(0, None, None).dauer(), Duration::from_secs_f64(1.0 / 60.0));
    }
}
