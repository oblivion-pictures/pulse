//! Der Vorhalt waehrend einer **Fernsteuerung** — zwei Betriebsarten mit
//! Umschalter im Fern-Menue.
//!
//! * **„Bild sofort zeigen" (Vorgabe seit 2026-10-21):** Vorhalt 0, jedes Bild
//!   geht hinaus, sobald es dekodiert ist; keine Regelung. Der Jitter-Puffer
//!   davor bleibt unveraendert (er wartet nur auf FEHLENDE Pakete).
//! * **geglaettet:** [`FERN_VORHALT_MS`] plus Regler ([`super::anpassung`]) —
//!   die Betriebsart bis zum 2026-10-21, Begruendung unten am Wert.
//!
//! Hier stand „ein Wert, zwei Betriebsarten"; gemeint war der Uebergang
//! Zusehen → Steuern.
//!
//! Kindmodul von [`super`] und nicht Nachbar: es fasst `vorhalt` und
//! `vorhalt_vor_fern` an, und die sind privat. Getrennt liegt es trotzdem, weil
//! der Ausgabe-Takt sonst die Groessen-Policy reisst (PLAN.md §12.1) — und weil
//! die Begruendung fuer den Wert laenger ist als die Rechnung dahinter.
//!
//! ## Bild sofort zeigen — Vorgabe seit 2026-10-21
//!
//! **Gemessen** (2026-10-21, Fernsteuerung Windows → Self-Host-Server →
//! Linux-Player des Eigentuemers, 1080p60 HEVC 2500 kbit/s, geglaettete
//! Betriebsart): der Regler verstellte den Vorhalt in 15 Minuten 114-mal,
//! immer zwischen 30 und 105 ms. Die verspaeteten Bilder hingen nicht mit
//! Ereignissen beim Sender zusammen, es war Netzschwankung auf der Strecke
//! Server→Zuschauer.
//!
//! **Am Bild beurteilt, nicht gemessen:** der Eigentuemer fand RustDesk, das
//! jedes Bild beim Eintreffen zeigt, fluessiger.
//!
//! **Gefolgert, nicht gemessen:** der Ruck kam vom Verstellen selbst (jede
//! Stufe warf die Zeitachse um, s. [`super::gleiten`]), und auf dieser
//! Strecke war der Vorhalt staendig zu klein fuer die Schwankung — er taktete
//! also ohnehin wenig, kostete aber 30-105 ms im geschlossenen Kreis aus
//! Eingabe und Bild. Ohne Vorhalt bleibt die Schwankung der Leitung im
//! Bildabstand sichtbar, dafuer kommt die eigene Mausbewegung so frueh zurueck
//! wie moeglich.
//!
//! **Warum ein Umschalter und nicht einfach 0.** Derselbe Gedanke stand schon
//! einmal hier (5 ms, 2026-08-12) und wurde am 2026-08-16 zurueckgenommen,
//! weil es auf einer wackligen Teststrecke ruckelte (Abschnitt unten). Welche
//! Seite der Abwaegung gewinnt, haengt also an der Strecke — wer auf einer
//! Leitung die Glaettung braucht, nimmt den Haken heraus und bekommt genau die
//! alte Betriebsart (30 ms plus Regler, der seit dem 2026-10-21 gleitet statt
//! springt). Der Haken gilt prozessweit und wird ueber Sitzungen gemerkt
//! (`app::sofortbild`, Desktop-Store `playerFernSofort`,
//! `PULSE_PLAYER_FERN_SOFORT`).
//!
//! **Die Zusage „Nicht 0" weiter unten haelt der Code nicht ein.** Sie
//! begruendet den Abstand zu 0 mit einer Warteschlange, „die eine verspaetete
//! Einheit noch einsortieren kann". Die Warteschlange sortiert aber nie:
//! `einreihen` setzt ein Bild mit kleinerem Zielzeitpunkt hinter seinen
//! Vorgaenger, ausdruecklich ohne Umordnung, und die Reihenfolge der Bilder
//! legt der Decoder fest. Bei 0 faellt also keine Reihenfolge-Korrektur weg,
//! sondern nur die Glaettung des Abstands (am Code nachgelesen).

use std::time::Duration;

use super::Ausgabetakt;

/// Vorhalt waehrend einer Fernsteuerung (s. [`Ausgabetakt::fernsteuerung`]).
///
/// **Gemessen, nicht gerechnet.** Der erste Ansatz waren 15 ms, hergeleitet aus
/// der Ankunfts-Schwankung (bis 21 ms ueber den Serverweg). Der Feldversuch am
/// 2026-08-12 mit 5 ms war deutlich besser als diese Rechnung erwarten liess —
/// derselbe Weg, dieselbe Leitung, 227 Messfenster:
///
/// | | Vorhalt 30 ms | Vorhalt 5 ms |
/// |---|---|---|
/// | Netz-bis-Schirm | 26-33 ms | **5,5 ms** |
/// | Bildabstand | 15,8-17,4 ms | 0,7-24,3 ms |
/// | „verspaetet" | 451 im Lauf | rund 55 je Sekunde |
///
/// **Was 5 ms wirklich bedeuten:** der Puffer haelt fast nichts mehr zurueck,
/// die Bilder gehen heraus, sobald sie da sind. Der Abstand schwankt dadurch
/// messbar — das ist die Gegenleistung, und sie ist bewusst eingekauft. Beim
/// Steuern zaehlt der geschlossene Kreis aus Eingabe hin und Bild zurueck; von
/// den rund 116 ms Netz laesst sich nichts abziehen, von diesen 26 ms fast
/// alles. Am Bild beurteilt war das Ruckeln dabei nicht wahrnehmbar.
///
/// **Nicht 0.** Auch bei einem kleinen Vorhalt bleibt eine Warteschlange, die
/// eine verspaetete Einheit noch einsortieren kann. Bei 0 faellt die
/// Reihenfolge-Korrektur ganz weg — das ist ein anderer Zustand, kein „noch
/// etwas schneller". **(Widerlegt am 2026-10-21, s. Modulkopf: die
/// Warteschlange sortiert nicht. Seitdem ist 0 die Vorgabe beim Steuern, und
/// dieser Wert gilt nur noch in der geglaetteten Betriebsart.)**
///
/// ## Zurueck auf 30 ms (2026-08-16)
///
/// **Die Messgrundlage der 5 ms gilt auf dieser Strecke nicht.** Sie stammt von
/// einer Leitung mit bis zu 21 ms Ankunfts-Schwankung. Auf der Testinstanz
/// wurden 50-100 ms gemessen — der Vorhalt lag damit bei einem Fuenftel bis
/// einem Zehntel dessen, was er ausgleichen muesste, und der Modulkopf von
/// [`super`] sagt, was dann passiert: es taktet nichts mehr. In Zahlen aus dem
/// Lauf vom 2026-08-15: 4784 verspaetete Bilder, also mehr als jedes zweite.
/// Der Ausgabe-Takt gab dann nur noch durch, statt zu takten — und genau das
/// sieht man als Ruckeln.
///
/// Der Beleg fuer den Wert steht im selben Protokoll: **ohne** Fernsteuerung
/// regelt der Takt selbst, und er landete auf demselben Weg bei 30, dann bei
/// 45 ms (`Vorhalt 30 -> 45 ms`). 5 ms waren also nicht nur knapp, sondern
/// gegen die Richtung, in die die Strecke von sich aus zeigt.
///
/// Der Preis ist bekannt und wurde bewusst gezahlt: rund 25 ms mehr im
/// geschlossenen Kreis aus Eingabe und Bild. Das ist wenig gegen die rund
/// 116 ms Netz — und ein gleichmaessiges Bild ist beim Steuern mehr wert als
/// 25 ms, die man nicht spuert. Die 5 ms bleiben oben dokumentiert: auf einer
/// kurzen, ruhigen Strecke waren sie messbar besser, und dorthin fuehrt der
/// Weg zurueck ueber einen Wert, der sich an der gemessenen Schwankung
/// ausrichtet, statt fest zu stehen.
///
/// Wer es schneller will, stellt es am Pruefstand ueber
/// `PULSE_PLAYER_AUSGABETAKT_MS` gegen — oder seit dem 2026-10-21 mit dem
/// Haken „Bild sofort zeigen" (Modulkopf).
pub const FERN_VORHALT_MS: u32 = 30;

/// Vorgabe des Hakens „Bild sofort zeigen": an (Modulkopf).
pub const FERN_SOFORT_VORGABE: bool = true;

/// `PULSE_PLAYER_FERN_SOFORT=0/1` — der Startwert des Hakens fuer diesen
/// Prozess. Setzt die Desktop-App aus ihrem Store (`player.ts`), damit der
/// Haken eine neue Sitzung und einen neuen Player-Prozess ueberlebt.
///
/// Ein unlesbarer Wert wird gemeldet und durch die Vorgabe ersetzt — aus
/// demselben Grund wie bei `vorhalt_aus_umgebung`.
pub fn fern_sofort_aus_umgebung() -> bool {
    let Ok(roh) = std::env::var("PULSE_PLAYER_FERN_SOFORT") else {
        return FERN_SOFORT_VORGABE;
    };
    match roh.trim() {
        "1" => true,
        "0" => false,
        _ => {
            eprintln!(
                "pulse-player: PULSE_PLAYER_FERN_SOFORT={roh:?} ist weder 0 noch 1 — \
                 Vorgabe bleibt"
            );
            FERN_SOFORT_VORGABE
        }
    }
}

impl Ausgabetakt {
/// Vorhalt fuer die Dauer einer Fernsteuerung absenken — und danach genau
    /// den Wert wiederherstellen, der vorher galt.
    ///
    /// **Warum ueberhaupt.** Der Vorhalt glaettet Schwankungen der Leitung; beim
    /// ZUSEHEN ist das ein guter Tausch, beim STEUERN zahlt man ihn als
    /// Verzoegerung im geschlossenen Kreis (Eingabe hin, Bild zurueck). Gemessen
    /// am 2026-08-12 ueber den Serverweg: Netz hin und zurueck rund 116 ms, der
    /// Vorhalt kam mit 30 ms obendrauf — ein Viertel dessen, was sich ueberhaupt
    /// beeinflussen laesst.
    ///
    /// **Warum hier und nicht in der App.** Der Player weiss ohnehin, wann eine
    /// Fernsteuerung laeuft (`input_capture`). Von aussen gesetzt braeuchte es
    /// einen zweiten Wert fuer „zurueck auf normal", der die Vorgabe von hier
    /// doppelt — und ein Zurueckstellen, das ausfaellt, sobald die App abstuerzt
    /// oder die Sitzung unerwartet endet. Dann bliebe der Rechner
    /// ruckelanfaellig, ohne dass es je jemand bemerkte.
    ///
    /// **Nur senken, nie anheben.** Wer selbst schon tiefer eingestellt hat
    /// (`PULSE_PLAYER_AUSGABETAKT_MS`, Pruefstand), bekommt seinen Wert nicht
    /// von der Fernsteuerung angehoben.
    ///
    /// **Gemerkt wird das Ziel, nicht der Zwischenstand** eines laufenden
    /// Regler-Uebergangs (s. [`super::gleiten`]): der Zwischenstand ist ein
    /// Moment, das Ziel ist der Wert, der gerade gilt.
    pub fn fernsteuerung(&mut self, aktiv: bool) {
        if aktiv {
            if self.vorhalt_vor_fern.is_some() {
                return;
            }
            self.vorhalt_vor_fern = Some(self.vorhalt_ziel);
            self.fern_wert_stellen();
        } else if let Some(alt) = self.vorhalt_vor_fern.take() {
            self.setze_vorhalt(alt.as_millis() as u32);
        }
    }

    /// Der Haken „Bild sofort zeigen" (s. Modulkopf). Wirkt sofort, wenn
    /// gerade gesteuert wird; sonst bei der naechsten Fernsteuerung.
    ///
    /// **Ein Wechsel mitten im Steuern faengt beim Wunsch des Nutzers an**,
    /// nicht beim gerade geltenden Wert: aus „sofort" heraus waere der 0, und
    /// „nur senken" machte daraus wieder 0. Was der Regler in der geglaetteten
    /// Betriebsart angehoben hatte, ist danach vergessen — wie beim Fern-Ende.
    pub fn fern_sofort_setzen(&mut self, an: bool) {
        if self.fern_sofort == an {
            return;
        }
        self.fern_sofort = an;
        if self.vorhalt_vor_fern.is_some() {
            self.fern_wert_stellen();
        }
    }

    #[cfg(test)]
    pub fn fern_sofort(&self) -> bool {
        self.fern_sofort
    }

    /// Fuer die Zaehlzeile: was gerade gilt, in einem Wort.
    pub fn betriebsart(&self) -> &'static str {
        match (self.vorhalt_vor_fern.is_some(), self.fern_sofort) {
            (false, _) => "zusehen",
            (true, true) => "fern sofort",
            (true, false) => "fern geglaettet",
        }
    }

    /// Den Vorhalt waehrend der Fernsteuerung aus dem gemerkten Wunsch und der
    /// Betriebsart stellen — EINE Rechnung fuer alle drei Wege dorthin
    /// (Einschalten, Nutzerwunsch, Haken). Sofort und mit neuer Untergrenze
    /// (`setze_vorhalt`), nicht gleitend: jeder dieser Wege ist eine Handlung.
    fn fern_wert_stellen(&mut self) {
        let Some(gewuenscht) = self.vorhalt_vor_fern else { return };
        let fern_ms = if self.fern_sofort { 0 } else { FERN_VORHALT_MS };
        let ziel = gewuenscht.min(Duration::from_millis(u64::from(fern_ms)));
        self.setze_vorhalt(ziel.as_millis() as u32);
    }

    /// Ein Vorhalt-Wunsch des Nutzers (`set_option ausgabetakt_ms`) — der EINE
    /// Weg dorthin, gleich ob gerade gesteuert wird oder nicht.
    ///
    /// **Warum nicht einfach [`Ausgabetakt::setze_vorhalt`].** Waehrend einer
    /// Fernsteuerung ist der geltende Vorhalt nicht der Wunsch des Nutzers,
    /// sondern die Absenkung — und `vorhalt_vor_fern` haelt den Wunsch fuer
    /// danach. Ein `set_option` direkt auf `setze_vorhalt` machte deshalb
    /// gleich zwei Dinge falsch: es hob die Fern-Absenkung still auf, und der
    /// gesetzte Wert war beim Fern-Ende wieder weg, weil dann der alte
    /// gemerkte Stand zurueckkam. Genau derselbe Fehler wurde am 2026-08-13
    /// fuer die Jitter-Geduld gefunden und dort mit dem Merker `fern_geduld`
    /// behoben (`session.rs`) — der Lautstaerkeregler sitzt im Fern-Menue,
    /// also faellt ein Options-Patch mitten in der Fernsteuerung wirklich an.
    ///
    /// Der Wunsch wird deshalb gemerkt und nur bis zum Fern-Wert **gesenkt**
    /// gestellt; die Zusage „nur senken, nie anheben" gilt hier wie oben.
    pub fn setze_vorhalt_vom_nutzer(&mut self, ms: u32) {
        let Some(_) = self.vorhalt_vor_fern else {
            return self.setze_vorhalt(ms);
        };
        let gewuenscht = Duration::from_millis(u64::from(ms.min(super::VORHALT_MAX_MS)));
        self.vorhalt_vor_fern = Some(gewuenscht);
        self.fern_wert_stellen();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(takt: &Ausgabetakt) -> u128 {
        takt.vorhalt.as_millis()
    }

    /// Ein Takt in der geglaetteten Betriebsart — die meisten Tests hier
    /// stammen aus der Zeit vor dem Haken und pruefen deren Zusagen weiter.
    fn geglaettet(vorhalt_ms: u32) -> Ausgabetakt {
        let mut takt = Ausgabetakt::neu(vorhalt_ms);
        takt.fern_sofort_setzen(false);
        takt
    }

    #[test]
    fn senkt_ab_und_gibt_genau_den_alten_wert_zurueck() {
        let mut takt = geglaettet(100);
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), u128::from(FERN_VORHALT_MS));
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 100, "der Wert VOR der Fernsteuerung, keine Vorgabe");
    }

    /// Die Vorgabe beim Steuern: Vorhalt 0, also Durchreichen — und danach
    /// genau der alte Wert.
    #[test]
    fn sofort_zeigen_ist_die_vorgabe_und_gibt_den_alten_wert_zurueck() {
        let mut takt = Ausgabetakt::neu(30);
        assert!(takt.fern_sofort(), "Vorgabe ist an");
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), 0);
        assert!(!takt.aktiv(), "Vorhalt 0 heisst Durchreichen");
        assert_eq!(takt.betriebsart(), "fern sofort");
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 30);
        assert_eq!(takt.betriebsart(), "zusehen");
    }

    /// Der Haken mitten in der Sitzung wirkt sofort, in beide Richtungen, und
    /// das Fern-Ende bringt trotzdem genau den Wert von vorher.
    #[test]
    fn der_haken_wirkt_mitten_in_der_sitzung() {
        let mut takt = Ausgabetakt::neu(100);
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), 0);
        takt.fern_sofort_setzen(false);
        assert_eq!(ms(&takt), u128::from(FERN_VORHALT_MS), "geglaettet: der Fern-Wert");
        assert_eq!(takt.betriebsart(), "fern geglaettet");
        takt.fern_sofort_setzen(true);
        assert_eq!(ms(&takt), 0);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 100);
    }

    /// Der Haken ausserhalb einer Fernsteuerung aendert am Zusehen nichts — er
    /// gilt fuer die naechste.
    #[test]
    fn der_haken_ohne_fernsteuerung_wartet_auf_die_naechste() {
        let mut takt = Ausgabetakt::neu(30);
        takt.fern_sofort_setzen(false);
        assert_eq!(ms(&takt), 30);
        takt.fern_sofort_setzen(true);
        assert_eq!(ms(&takt), 30);
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), 0);
    }

    /// Ein Regler-Uebergang beim Einschalten: gemerkt wird das ZIEL, nicht der
    /// Zwischenstand — sonst kaeme nach dem Fern-Ende ein krummer Moment-Wert
    /// zurueck.
    #[test]
    fn beim_einschalten_wird_das_ziel_gemerkt() {
        let mut takt = Ausgabetakt::neu(30);
        takt.ziel_setzen(45);
        takt.gleiten();
        assert_eq!(ms(&takt), 31);
        takt.fernsteuerung(true);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 45);
    }

    #[test]
    fn hebt_einen_selbst_gesetzten_tieferen_wert_nicht_an() {
        // `PULSE_PLAYER_AUSGABETAKT_MS=2` am Pruefstand: die Fernsteuerung darf
        // daraus keine 5 machen, sonst misst der Pruefstand etwas anderes, als
        // er eingestellt hat. Bewusst UNTER [`FERN_VORHALT_MS`] gewaehlt —
        // gleichauf wuerde der Test bestehen, ohne irgendetwas zu pruefen.
        // Geglaettet, weil „sofort" ohnehin auf 0 senkt.
        let mut takt = geglaettet(2);
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), 2);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 2);
    }

    #[test]
    fn zweimal_einschalten_verliert_den_gemerkten_wert_nicht() {
        // Ein zweites `input_capture` mit `enabled: true` (Slot- oder
        // Sitzungswechsel mitten in der Fernsteuerung) darf den gemerkten Stand
        // nicht mit dem bereits abgesenkten ueberschreiben — sonst bliebe der
        // Player nach dem Ende dauerhaft auf dem kleinen Vorhalt. Mit der
        // Vorgabe „sofort", weil der Unterschied dort am groessten waere (0).
        let mut takt = Ausgabetakt::neu(30);
        takt.fernsteuerung(true);
        takt.fernsteuerung(true);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 30);
    }

    /// `set_option ausgabetakt_ms` mitten in der Fernsteuerung (der
    /// Lautstaerkeregler sitzt im Fern-Menue, der Fall ist real): die
    /// Absenkung bleibt, und der Wunsch geht beim Fern-Ende nicht verloren.
    #[test]
    fn ein_nutzerwert_waehrend_der_fernsteuerung_ueberlebt_das_ende() {
        let mut takt = geglaettet(100);
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), u128::from(FERN_VORHALT_MS));
        takt.setze_vorhalt_vom_nutzer(80);
        assert_eq!(ms(&takt), u128::from(FERN_VORHALT_MS), "die Fern-Absenkung bleibt stehen");
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 80, "der waehrenddessen gesetzte Wunsch gilt danach");
    }

    /// Und die Gegenrichtung: ein Wunsch UNTER dem Fern-Wert wird nicht
    /// angehoben — dieselbe Zusage wie beim Einschalten.
    #[test]
    fn ein_tieferer_nutzerwert_waehrend_der_fernsteuerung_gilt_sofort() {
        let mut takt = geglaettet(100);
        takt.fernsteuerung(true);
        takt.setze_vorhalt_vom_nutzer(2);
        assert_eq!(ms(&takt), 2);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 2);
    }

    /// Dieselbe Zusage in der Vorgabe-Betriebsart: der Wunsch mitten im
    /// Steuern hebt die 0 nicht an, und er gilt nach dem Ende.
    #[test]
    fn ein_nutzerwert_beim_sofort_zeigen_wartet_aufs_ende() {
        let mut takt = Ausgabetakt::neu(100);
        takt.fernsteuerung(true);
        takt.setze_vorhalt_vom_nutzer(80);
        assert_eq!(ms(&takt), 0, "„sofort\" bleibt sofort");
        // Und wer jetzt auf geglaettet wechselt, bekommt den Fern-Wert, nicht
        // seinen neuen Wunsch — „nur senken" gilt gegen den Wunsch.
        takt.fern_sofort_setzen(false);
        assert_eq!(ms(&takt), u128::from(FERN_VORHALT_MS));
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 80);
    }

    #[test]
    fn ausschalten_ohne_einschalten_aendert_nichts() {
        let mut takt = Ausgabetakt::neu(30);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 30);
    }
}
