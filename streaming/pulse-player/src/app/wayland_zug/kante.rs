//! Ob ein vorgemerkter Zug ueber die Fenstergrenze JETZT ausgeloest wird —
//! die reine Entscheidung hinter [`super::rand`], ohne winit, ohne Wayland,
//! ohne Fenster und deshalb ohne Compositor pruefbar.
//!
//! Abgetrennt von [`super::rand`], wo die Verdrahtung steht (wann gefragt
//! wird, woher die Rechtecke kommen, was danach geschieht) — dieselbe
//! Trennung wie `zuordnung` neben dem Modulkopf und dieselbe Ursache: beides
//! in einer Datei lag ueber der Groessen-Grenze (`PLAN.md` §12.1).
//!
//! Die Regeln (Begruendung im Modulkopf von [`super::rand`]):
//! * kein Knopf gehalten -> vergessen;
//! * Zeiger noch im Fenster -> weiter warten;
//! * kein Nachbar -> nie ausloesen;
//! * draussen, und die verlassene Kante kann zu einem Nachbarn fuehren ->
//!   ausloesen. „Kann" heisst: Richtung bekannt und passend, ODER Richtung
//!   unbekannt (eine Lage fehlt oder die Rechtecke ueberlappen).

// Gerufen wird das nur auf Linux (`rand`); ohne diese Zeile meldete ein
// Windows-/macOS-Bau es als toten Code.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// Ein Rechteck in LOGISCHEN Desktop-Punkten — nur fuer die Richtung, in der
/// ein Nachbar liegt (woher es kommt: `rand::vollbild_rechteck`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Rechteck {
    pub x: f64,
    pub y: f64,
    pub breite: f64,
    pub hoehe: f64,
}

/// Eine Auswahl der vier Fensterkanten.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Kanten {
    links: bool,
    rechts: bool,
    oben: bool,
    unten: bool,
}

impl Kanten {
    /// Ueber welche Kanten der Zeiger hinaus ist — physische Fensterpunkte
    /// gegen die physische Innengroesse, beides aus winit. An einer Ecke
    /// koennen es zwei sein.
    fn verlassen(zeiger: (f64, f64), groesse: (f64, f64)) -> Self {
        Self {
            links: zeiger.0 < 0.0,
            rechts: zeiger.0 >= groesse.0,
            oben: zeiger.1 < 0.0,
            unten: zeiger.1 >= groesse.1,
        }
    }

    /// In welcher Richtung `nachbar` von `eigen` aus liegt: sein Mittelpunkt
    /// jenseits der jeweiligen Kante. Ueber den Mittelpunkt statt ueber exakte
    /// Kantengleichheit, damit eine Rundung an der Monitorgrenze nichts kippt.
    /// Ueberlappen sich beide so, dass der Mittelpunkt innen liegt, kommt keine
    /// Kante heraus — das heisst „Richtung unbestimmt", nicht „kein Nachbar".
    fn richtung(eigen: &Rechteck, nachbar: &Rechteck) -> Self {
        let mitte_x = nachbar.x + nachbar.breite / 2.0;
        let mitte_y = nachbar.y + nachbar.hoehe / 2.0;
        Self {
            links: mitte_x < eigen.x,
            rechts: mitte_x > eigen.x + eigen.breite,
            oben: mitte_y < eigen.y,
            unten: mitte_y > eigen.y + eigen.hoehe,
        }
    }

    fn keine(self) -> bool {
        self == Self::default()
    }

    fn gemeinsam(self, andere: Self) -> bool {
        (self.links && andere.links)
            || (self.rechts && andere.rechts)
            || (self.oben && andere.oben)
            || (self.unten && andere.unten)
    }
}

/// Was ein Fensterereignis fuer einen vorgemerkten Zug bedeutet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Randschritt {
    /// Vorgemerkt bleiben (Zeiger noch drin, oder die Kante fuehrt zu keinem
    /// Nachbarn — er kann an einer anderen noch hinaus).
    Weiter,
    /// Kein Knopf mehr unten: die Vormerkung verfaellt. Es gibt nichts
    /// abzubauen, weil nie ein `start_drag` hinausging.
    Vergessen,
    /// Jetzt `start_drag`.
    Ausloesen,
}

/// Der Anlass, zu dem [`randschritt`] gefragt wird.
pub(super) enum Randanlass {
    /// `CursorMoved`, physische Fensterpunkte, dazu die physische Innengroesse.
    Bewegt { zeiger: (f64, f64), groesse: (f64, f64), knopf_unten: bool },
    /// `MouseInput` losgelassen; `knopf_unten`: ob danach noch einer haelt.
    Losgelassen { knopf_unten: bool },
}

/// Die ganze Entscheidung als reine Funktion.
///
/// `nachbarschaft` liefert das eigene Rechteck und eines je Nachbar (`None` =
/// Lage unbekannt). Sie wird erst gerufen, wenn der Zeiger wirklich draussen
/// ist — `window_event` laeuft bei jeder Bewegung, und solange der Zeiger im
/// Fenster bleibt, soll das nur diesen Vergleich kosten.
pub(super) fn randschritt(
    anlass: Randanlass,
    nachbarschaft: impl FnOnce() -> (Option<Rechteck>, Vec<Option<Rechteck>>),
) -> Randschritt {
    let (zeiger, groesse) = match anlass {
        Randanlass::Losgelassen { knopf_unten: true } => return Randschritt::Weiter,
        Randanlass::Losgelassen { knopf_unten: false }
        | Randanlass::Bewegt { knopf_unten: false, .. } => return Randschritt::Vergessen,
        Randanlass::Bewegt { zeiger, groesse, knopf_unten: true } => (zeiger, groesse),
    };
    let kanten = Kanten::verlassen(zeiger, groesse);
    if kanten.keine() {
        return Randschritt::Weiter;
    }
    let (eigen, nachbarn) = nachbarschaft();
    let erreichbar = nachbarn.iter().any(|nachbar| match (eigen, nachbar) {
        (Some(eigen), Some(nachbar)) => {
            let richtung = Kanten::richtung(&eigen, nachbar);
            richtung.keine() || richtung.gemeinsam(kanten)
        }
        // Eine Lage unbekannt: jede Kante kann zu ihm fuehren.
        _ => true,
    });
    if erreichbar {
        Randschritt::Ausloesen
    } else {
        Randschritt::Weiter
    }
}

#[cfg(test)]
mod tests {
    use super::{randschritt, Randanlass, Randschritt, Rechteck};

    const GROESSE: (f64, f64) = (1920.0, 1080.0);

    fn monitor(x: f64, y: f64) -> Option<Rechteck> {
        Some(Rechteck { x, y, breite: 1920.0, hoehe: 1080.0 })
    }

    fn bewegt(x: f64, y: f64) -> Randanlass {
        Randanlass::Bewegt { zeiger: (x, y), groesse: GROESSE, knopf_unten: true }
    }

    /// Links A, rechts daneben B — beide Vollbild.
    fn nebeneinander() -> (Option<Rechteck>, Vec<Option<Rechteck>>) {
        (monitor(0.0, 0.0), vec![monitor(1920.0, 0.0)])
    }

    /// **Der Fehlerfall vom 2026-10-15:** EIN Fenster, kein Nachbar — nie ein
    /// Zug, auch nicht am Rand.
    #[test]
    fn ohne_nachbarn_kein_zug() {
        let allein = || (monitor(0.0, 0.0), Vec::new());
        assert_eq!(randschritt(bewegt(2000.0, 500.0), allein), Randschritt::Weiter);
        assert_eq!(randschritt(bewegt(-5.0, -5.0), allein), Randschritt::Weiter);
    }

    /// Mit Nachbar, Zeiger noch im Fenster: kein Zug — und die Nachbarschaft
    /// wird dafuer nicht einmal ausgerechnet.
    #[test]
    fn zeiger_drinnen_kein_zug() {
        let schritt = randschritt(bewegt(1919.0, 1079.0), || {
            panic!("die Nachbarschaft darf drinnen nicht gefragt werden")
        });
        assert_eq!(schritt, Randschritt::Weiter);
    }

    #[test]
    fn hinaus_zur_kante_mit_nachbar_loest_aus() {
        assert_eq!(randschritt(bewegt(1920.0, 500.0), nebeneinander), Randschritt::Ausloesen);
    }

    /// Nach links/oben/unten liegt kein Nachbar — vorgemerkt bleiben, der
    /// Zeiger kann noch nach rechts hinueber.
    #[test]
    fn hinaus_zur_kante_ohne_nachbar_loest_nicht_aus() {
        assert_eq!(randschritt(bewegt(-1.0, 500.0), nebeneinander), Randschritt::Weiter);
        assert_eq!(randschritt(bewegt(500.0, -1.0), nebeneinander), Randschritt::Weiter);
        assert_eq!(randschritt(bewegt(500.0, 1080.0), nebeneinander), Randschritt::Weiter);
    }

    /// Untereinander: unten loest aus, rechts nicht.
    #[test]
    fn nachbar_darunter() {
        let untereinander = || (monitor(0.0, 0.0), vec![monitor(0.0, 1080.0)]);
        assert_eq!(randschritt(bewegt(500.0, 1100.0), untereinander), Randschritt::Ausloesen);
        assert_eq!(randschritt(bewegt(1950.0, 500.0), untereinander), Randschritt::Weiter);
    }

    /// An der Ecke zaehlt jede der beiden Kanten.
    #[test]
    fn ecke_mit_einer_passenden_kante_loest_aus() {
        assert_eq!(randschritt(bewegt(1925.0, -3.0), nebeneinander), Randschritt::Ausloesen);
    }

    /// Lage unbekannt (kein Vollbild, kein Monitor) — eigene ODER fremde:
    /// jede Kante kann zum Nachbarn fuehren. Lieber ein Zug zu viel als ein
    /// Uebergang, der nicht mehr geht.
    #[test]
    fn unbekannte_lage_laesst_jede_kante_zu() {
        let eigene_unbekannt = || (None, vec![monitor(1920.0, 0.0)]);
        assert_eq!(randschritt(bewegt(-1.0, 500.0), eigene_unbekannt), Randschritt::Ausloesen);
        let fremde_unbekannt = || (monitor(0.0, 0.0), vec![None]);
        assert_eq!(randschritt(bewegt(500.0, -1.0), fremde_unbekannt), Randschritt::Ausloesen);
    }

    /// Ueberlappen sich die Rechtecke (Mittelpunkt innen), ist die Richtung
    /// unbestimmt — das ist kein „kein Nachbar".
    #[test]
    fn ueberlappung_heisst_richtung_unbestimmt() {
        let gleich = || (monitor(0.0, 0.0), vec![monitor(100.0, 0.0)]);
        assert_eq!(randschritt(bewegt(-1.0, 500.0), gleich), Randschritt::Ausloesen);
    }

    /// Ohne gehaltenen Knopf gibt es keine Ergreifung mehr, an der
    /// `start_drag` haengen koennte — vergessen, auch am Rand.
    #[test]
    fn ohne_knopf_wird_vergessen() {
        let anlass =
            Randanlass::Bewegt { zeiger: (2000.0, 500.0), groesse: GROESSE, knopf_unten: false };
        assert_eq!(randschritt(anlass, nebeneinander), Randschritt::Vergessen);
    }

    /// **Loslassen, bevor der Zeiger hinaus ist:** die Vormerkung verfaellt
    /// (`Vergessen`, nicht `wayland_zug_abbau`) — weil nie ein `start_drag`
    /// hinausging, ist nichts abzubauen und nichts freizugeben; der Knopf geht
    /// ueber den gewoehnlichen `MouseInput`-Weg hoch wie bei jedem Klick.
    #[test]
    fn loslassen_vor_dem_rand_vergisst_nur() {
        let schritt = randschritt(Randanlass::Losgelassen { knopf_unten: false }, || {
            panic!("beim Loslassen zaehlt die Nachbarschaft nicht")
        });
        assert_eq!(schritt, Randschritt::Vergessen);
    }

    /// Haelt noch ein anderer Knopf, besteht die Ergreifung weiter.
    #[test]
    fn loslassen_eines_von_zwei_knoepfen_bleibt_vorgemerkt() {
        let schritt = randschritt(Randanlass::Losgelassen { knopf_unten: true }, nebeneinander);
        assert_eq!(schritt, Randschritt::Weiter);
    }
}
