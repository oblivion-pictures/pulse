//! WANN der Zug ueber die Fenstergrenze ausgeloest wird: nicht beim Druck,
//! sondern erst, wenn der Zeiger mit gehaltenem Knopf das Fenster ueber eine
//! Kante verlaesst, hinter der ein Nachbarfenster liegen kann.
//!
//! ## Warum nicht mehr beim Druck (2026-10-15)
//!
//! Bis dahin ging `start_drag` bei JEDEM angenommenen Druck hinaus. Unter
//! `niri` zeigt sich damit die obere Leiste (Layer-Shell) ueber dem
//! Vollbild-Player, solange die Taste gehalten wird — vermutlich, weil der
//! Compositor die Ebene waehrend eines Ziehvorgangs nach vorn holt (das ist
//! **gefolgert, nicht gemessen**; gemeldet ist nur das Bild: Leiste sichtbar,
//! solange gehalten). Mit EINEM Fenster gibt es aber gar keine Grenze, ueber
//! die etwas zu ziehen waere, und auch mit zweien braucht es den Zug erst, wenn
//! der Zeiger wirklich hinueber will.
//!
//! ## Der Ablauf jetzt
//!
//! 1. **Vormerken** ([`App::wayland_zug_vormerken`]) beim angenommenen Druck —
//!    dasselbe Tor wie vorher (Review I2/M-a, Zeigerfang-Ausnahme Review I-2),
//!    derselbe Abbau davor. Es geht noch NICHTS an den Compositor.
//! 2. **Ausloesen** beim ersten `CursorMoved` AUSSERHALB der Fensterflaeche,
//!    solange ein Knopf gehalten wird und [`super::kante::randschritt`] es
//!    erlaubt: es muss ein Nachbar existieren (erfassendes Fenster derselben
//!    Fernsteuerungs-Sitzung), und die verlassene Kante muss zu ihm zeigen
//!    koennen.
//! 3. **Vergessen**, sobald kein Knopf mehr gehalten wird. Ein Zug, der nie
//!    begann, hinterlaesst nichts — losgelassen wird ueber den gewoehnlichen
//!    `MouseInput`-Weg wie bei jedem Klick.
//!
//! ## Woher die Koordinaten ausserhalb kommen (nachgesehen)
//!
//! Waehrend der impliziten Ergreifung behaelt das gedrueckte Fenster den
//! Zeigerfokus, und der Compositor schickt `wl_pointer.motion` relativ zu
//! dessen Flaeche weiter — auch jenseits ihrer Raender. Winit 0.30.13 reicht
//! das ungefiltert durch: `platform_impl/linux/wayland/seat/pointer/mod.rs`,
//! Zweig `PointerEventKind::Motion`, rechnet `event.position` nur logisch ->
//! physisch um und schickt `CursorMoved`, ohne gegen die Fenstergroesse zu
//! klemmen oder zu filtern. Dass der Compositor die Bewegung waehrend der
//! Ergreifung ausserhalb weiter meldet, steht so nicht im Protokolltext
//! (`wl_pointer.motion`: "relative to the focused surface"), es folgt aus dem
//! Fokus-Halten der Ergreifung — **gefolgert, nicht gemessen**;
//! `fernsteuerung::nachbarn` baut auf X11/Windows/macOS auf derselben Annahme.
//!
//! ## Die Seriennummer bleibt die des Drucks
//!
//! `start_drag` verlangt laut Protokoll ("the client must have an active
//! implicit grab that matches the serial") die Nummer einer NOCH LAUFENDEN
//! impliziten Ergreifung. Die liefert weiter
//! `Gastverbindung::letzte_druck_nummer` — gesetzt beim `wl_pointer.button`
//! des zweiten Zeigers, entwertet NUR von `Drop`/`Leave` eines eigenen Zugs
//! (`fernsteuerung::wayland::zustand`). Zwischen Druck und Austritt laeuft kein
//! Zug, also entwertet auch nichts. Die Ergreifung selbst haelt, solange der
//! Knopf unten ist — deshalb verlangt [`super::kante::randschritt`] den
//! gehaltenen Knopf.
//! Kommt das Loslassen dem `start_drag` beim Compositor zuvor, verwirft er die
//! Anfrage still (aus dem Protokoll gefolgert, s. `wayland::zug`), und das
//! folgende `MouseInput`-Loslassen raeumt den unbestaetigten Zug wie bisher ab
//! (`griff_pruefen`).
//!
//! ## Welche Kante zu einem Nachbarn zeigt
//!
//! Wayland nennt keine Fensterlagen (`inner_position()` ist
//! `NotSupportedError`). Bekannt ist nur die Lage des MONITORS, auf dem ein
//! VOLLBILD-Fenster liegt — und ein Vollbild deckt ihn ganz. Fuer zwei
//! Vollbild-Fenster laesst sich die Richtung also bestimmen
//! ([`vollbild_rechteck`]); fuer jedes andere Fenster nicht, und dann gilt
//! JEDE Kante als moegliche (lieber ein Zug zu viel als ein Uebergang, der
//! nicht mehr geht).
//!
//! ## Ein Zug, der ausserhalb beginnt, wird anders bestaetigt
//!
//! Der Compositor uebernimmt den Zeiger mit der naechsten Bewegung nach
//! `start_drag` — jetzt also ueber dem Nachbarn, in der Luecke dazwischen oder
//! ueber einem fremden Fenster. Nur im ersten Fall kommt ein `Enter`. Fuer die
//! anderen beiden nimmt [`App::wayland_zug_rand`] winits `CursorLeft` am
//! Ursprungsfenster als Zeichen der Uebernahme (s.
//! `wayland::zustand::draussen_angelaufen`, dort auch, was daran gefolgert
//! ist).

#[cfg(target_os = "linux")]
use winit::event::{ElementState, WindowEvent};

#[cfg(target_os = "linux")]
use super::kante::{randschritt, Randanlass, Randschritt, Rechteck};

use super::App;

impl App {
    /// Beim angenommenen Druck (Tor beim Aufrufer, `window_event`): den Zug
    /// VORMERKEN, nicht beginnen (s. Modulkopf).
    ///
    /// **Abgebaut wird trotzdem schon hier** (Review 1 der fuenften Runde),
    /// genau wie frueher beim Beginn: was von einem vorigen Zug noch steht,
    /// gehoert nicht zu diesem Druck. Ohne Freigabe — ein etwaiges Ende hat
    /// `griff_pruefen` im selben `window_event` schon abgeholt.
    #[cfg(target_os = "linux")]
    pub(in crate::app) fn wayland_zug_vormerken(&mut self, id: u64) {
        // Falls das Einschalten die Verbindung nicht gebaut hat (Sitzung erst
        // nach dem `input_capture` entstanden): hier noch einmal.
        self.wayland_zug_bereitstellen(id);
        let Some(session) = self.sessions.get(&id) else { return };
        // Bei gefangenem Zeiger gibt es keine Grenze zum Ueberqueren, und der
        // Beweisweg (`CursorMoved`) fehlt (Review I-2, s. `wayland_zug`-Kopf).
        if session.eingabe.zeigerfang() {
            return;
        }
        self.wayland_zug_abbau(false);
        if self.wayland_zug.inner.verbindung.is_some() {
            self.wayland_zug.inner.vorgemerkt = Some(id);
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(in crate::app) fn wayland_zug_vormerken(&mut self, _id: u64) {}

    /// Bei jedem Fensterereignis, NACH `Erfassung::on_window_event` (die
    /// Knopf-Menge ist dann auf dem Stand dieses Ereignisses): einen
    /// vorgemerkten Zug ausloesen oder vergessen, und bei einem laufenden das
    /// `CursorLeft` als Uebernahme werten (s. Modulkopf).
    ///
    /// **`CursorLeft` bei blosser Vormerkung heisst: die Ergreifung ist weg.**
    /// Waehrend sie haelt, behaelt das Fenster den Zeigerfokus auch ausserhalb
    /// (s. Modulkopf) — ein `wl_pointer.leave`, und nur daraus macht winit
    /// `CursorLeft`, kommt dann erst, wenn sie endet oder der Compositor sie
    /// abbricht. Ein `start_drag` danach griffe ins Leere; die Vormerkung
    /// verfaellt deshalb hier.
    #[cfg(target_os = "linux")]
    pub(in crate::app) fn wayland_zug_rand(&mut self, id: u64, ereignis: &WindowEvent) {
        if matches!(ereignis, WindowEvent::CursorLeft { .. }) {
            if self.wayland_zug.inner.vorgemerkt == Some(id) {
                self.wayland_zug.inner.vorgemerkt = None;
                // Haelt ein Compositor den Fokus waehrend der Ergreifung NICHT
                // (die Annahme oben ist gefolgert), verschwaende hier sonst
                // jeder Uebergang still.
                eprintln!(
                    "pulse-player: Zeiger hat das Fenster bei gehaltenem Knopf verlassen \
                     (`CursorLeft`) — vorgemerkter Zug ueber die Fenstergrenze verworfen."
                );
            }
            self.wayland_zug_draussen(id);
            return;
        }
        if self.wayland_zug.inner.vorgemerkt != Some(id) {
            return;
        }
        let Some(session) = self.sessions.get(&id) else { return };
        let knopf_unten = session.eingabe.knopf_unten();
        let anlass = match ereignis {
            WindowEvent::CursorMoved { position, .. } => {
                let groesse = session.window.inner_size();
                Randanlass::Bewegt {
                    zeiger: (position.x, position.y),
                    groesse: (f64::from(groesse.width), f64::from(groesse.height)),
                    knopf_unten,
                }
            }
            WindowEvent::MouseInput { state: ElementState::Released, .. } => {
                Randanlass::Losgelassen { knopf_unten }
            }
            _ => return,
        };
        match randschritt(anlass, || self.zug_nachbarschaft(id)) {
            Randschritt::Weiter => {}
            Randschritt::Vergessen => self.wayland_zug.inner.vorgemerkt = None,
            Randschritt::Ausloesen => self.wayland_zug_beginnen(id),
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(in crate::app) fn wayland_zug_rand(
        &mut self,
        _id: u64,
        _ereignis: &winit::event::WindowEvent,
    ) {
    }

    /// `start_drag` — erst jetzt, am Rand (s. Modulkopf). Raeumt zuerst ueber
    /// den einen Trichter ab; das nimmt auch die Vormerkung mit.
    ///
    /// **Kein `nachfassen()` hier** (C1 der ersten Runde): die Seriennummer
    /// dieses Drucks hat `griff_pruefen` beim Druck selbst dispatcht, und
    /// `wayland_zug_nachfassen` laeuft seither in jedem Durchlauf. Ein
    /// zusaetzliches koennte ein `Drop` abholen, das der Abbau gleich darauf
    /// wegraeumte.
    #[cfg(target_os = "linux")]
    fn wayland_zug_beginnen(&mut self, id: u64) {
        let Some(session) = self.sessions.get(&id) else { return };
        // Guertel zur Pruefung beim Vormerken: der Zeigerfang kann zwischen
        // Druck und Austritt eingeschaltet worden sein.
        if session.eingabe.zeigerfang() {
            self.wayland_zug.inner.vorgemerkt = None;
            return;
        }
        self.wayland_zug_abbau(false);
        let Some(session) = self.sessions.get(&id) else { return };
        let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
        if verbindung.zug_beginnen(&session.window) {
            self.wayland_zug.inner.session = Some(id);
            self.wayland_zug.inner.ziel_fehler_gemeldet = false;
        } else {
            // Review I4: still zu bleiben war genau die Stelle, an der der
            // C1-Befund sich verstecken konnte.
            eprintln!(
                "pulse-player: Zug ueber die Fenstergrenze nicht gestartet \
                 (kein frischer Druck oder Fenster ohne Wayland-Flaeche)."
            );
        }
    }

    /// `CursorLeft` am Ursprungsfenster eines angeforderten Zugs: der
    /// Compositor hat den Zeiger uebernommen. Erst den Stapel leeren — kam das
    /// `Enter` des Nachbarn im selben Lesevorgang, bestaetigt DAS den Zug, und
    /// [`crate::fernsteuerung::wayland::Gastverbindung::zug_draussen_angelaufen`]
    /// laesst ihn dann unberuehrt.
    #[cfg(target_os = "linux")]
    fn wayland_zug_draussen(&mut self, id: u64) {
        if self.wayland_zug.inner.session != Some(id) {
            return;
        }
        let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
        let schluss = verbindung.nachfassen();
        self.wayland_zug_schluss_anwenden(schluss);
        if self.wayland_zug.inner.session != Some(id) {
            return;
        }
        if let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() {
            verbindung.zug_draussen_angelaufen();
        }
    }

    /// Eigenes Rechteck und die der Nachbarn: erfassende Fenster DERSELBEN
    /// Fernsteuerungs-Sitzung, ausser dem eigenen — dieselben zwei Filter wie
    /// in `window_event` und `zuordnung::ziel_fuer` (`docs/fernsteuerung.md`:
    /// „Beide Filter gehoeren in JEDEN Weg, der ein Zielfenster bestimmt").
    /// Ohne eigene Sitzungskennung keine Nachbarn (fail-closed, wie
    /// `ohne_ziel` in `window_event`) — dann bleibt es beim einzelnen Fenster.
    #[cfg(target_os = "linux")]
    fn zug_nachbarschaft(&self, id: u64) -> (Option<Rechteck>, Vec<Option<Rechteck>>) {
        let Some(eigene) = self.sessions.get(&id) else { return (None, Vec::new()) };
        let Some(sitzung) = eigene.eingabe.sitzung() else { return (None, Vec::new()) };
        let nachbarn: Vec<_> = self
            .sessions
            .iter()
            .filter(|(sid, s)| {
                **sid != id && s.eingabe.aktiv() && s.eingabe.sitzung() == Some(sitzung)
            })
            .map(|(_, s)| vollbild_rechteck(&s.window))
            .collect();
        // Allein: die eigene Lage wird gar nicht erst erfragt (Monitor-Abfrage
        // bei jeder Bewegung jenseits des Rands, die nichts entscheidet).
        if nachbarn.is_empty() {
            return (None, nachbarn);
        }
        (vollbild_rechteck(&eigene.window), nachbarn)
    }
}

/// Das logische Desktop-Rechteck eines VOLLBILD-Fensters — `None` fuer jedes
/// andere oder wenn winit den Monitor nicht kennt (s. Modulkopf).
///
/// **Nachgesehen in winit 0.30.13** (`platform_impl/linux/wayland/output.rs`):
/// `MonitorHandle::position()` ist die logische Lage (`xdg_output`) MAL dem
/// ganzzahligen `wl_output`-Faktor, `scale_factor()` ist genau dieser Faktor —
/// die Division gibt die logische Lage exakt zurueck. `size()` wird bewusst
/// NICHT benutzt: es ist die physische Modus-Groesse ohne Drehung. Die Groesse
/// kommt stattdessen vom Fenster selbst (physisch durch dessen eigenen,
/// gebrochenen Faktor = logisch) — ein Vollbild deckt seinen Monitor ganz.
#[cfg(target_os = "linux")]
fn vollbild_rechteck(fenster: &winit::window::Window) -> Option<Rechteck> {
    fenster.fullscreen()?;
    let monitor = fenster.current_monitor()?;
    let monitor_faktor = monitor.scale_factor();
    let lage = monitor.position();
    let faktor = fenster.scale_factor();
    let groesse = fenster.inner_size();
    Some(Rechteck {
        x: f64::from(lage.x) / monitor_faktor,
        y: f64::from(lage.y) / monitor_faktor,
        breite: f64::from(groesse.width) / faktor,
        hoehe: f64::from(groesse.height) / faktor,
    })
}
