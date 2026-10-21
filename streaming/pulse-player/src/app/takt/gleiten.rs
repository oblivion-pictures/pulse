//! Der Regler verstellt den Vorhalt **gleitend**, nicht in einem Sprung.
//!
//! Kindmodul von [`super`] wie [`super::anpassung`]: es fasst `vorhalt`,
//! `vorhalt_ziel` und den Anker an, und die sind privat.
//!
//! ## Warum (Messung vom 2026-10-21)
//!
//! **Gemessen:** Bei einer Fernsteuerung ueber den Serverweg (1080p60 HEVC,
//! 2500 kbit/s, Windows-Sender, Linux-Player) hat der Regler den Vorhalt in
//! 15 Minuten 114-mal verstellt, immer zwischen 30 und 105 ms in Stufen von
//! 15 ms (`[takt] Vorhalt X -> Y ms` im `sidecar.log`). Die verspaeteten
//! Bilder fielen nicht mit Ereignissen beim Sender zusammen, sie waren
//! Netzschwankung auf der Strecke Server→Zuschauer.
//!
//! **Am Code nachvollzogen, nicht am Bild gemessen:** jede Stufe lief ueber
//! `vorhalt_anwenden`, und das setzt den Anker zurueck und macht alle
//! wartenden Bilder sofort faellig. [`super::Ausgabetakt::faellig`] zeigt
//! davon nur das juengste — die anderen sind uebersprungen —, und das naechste
//! Bild bekommt einen frischen Anker `jetzt + Vorhalt`, steht also den ganzen
//! Vorhalt lang. Ein sichtbarer Ruck je Stufe, bei 114 Stufen in 15 Minuten
//! rund 7-mal je Minute.
//!
//! ## Was hier stattdessen passiert
//!
//! Der Regler setzt nur noch das ZIEL ([`Ausgabetakt::ziel_setzen`]). Der
//! Vorhalt rueckt ihm mit jedem eingereihten Bild um hoechstens
//! [`SCHRITT_MAX`] naeher, und der Anker wandert um genau den Schritt mit. Die
//! Bildfolge laeuft dabei kurz etwas langsamer (anheben) oder schneller
//! (senken) als die Senderuhr; bei 60 fps dauert eine 15-ms-Stufe rund 250 ms
//! und die Abweichung liegt bei rund 6 %. Unsichtbar ist das nach Rechnung,
//! nicht nach Sichtpruefung — am Schirm beurteilt ist es noch nicht.
//!
//! ## Warum der Anker auch beim Senken mitwandert
//!
//! Naheliegend war, beim Senken nur den Vorhalt kleiner zu machen und den Rest
//! dem Nachziehen in `ziel` zu ueberlassen (der Anker wandert dort auf die
//! kuerzeste Laufzeit). **Am Code nachgerechnet traegt das nicht:** das
//! Nachziehen greift nur bei einem Bild, das um weniger als die bisher
//! aufgelaufene Senkung spaeter kommt als das schnellste. Auf einer
//! schwankenden Leitung sind solche Bilder selten — der Vorhalt staende dann
//! als Zahl schon tiefer, waehrend die Bilder weiter mit dem alten warten, und
//! das erste schnelle Bild zoege den Anker in EINEM Ruck um alles Aufgelaufene
//! nach. Genau der Sprung, den dieses Modul abschaffen soll. Mit dem Anker
//! symmetrisch in beide Richtungen bleibt das Nachziehen, was es war: die
//! Korrektur fuer Bilder, die schneller kommen, als der Anker erlaubt.
//!
//! ## Was NICHT gleitet
//!
//! Alles, was jemand ausloest, gilt sofort: ein von Hand gesetzter Wert
//! (`setze_vorhalt`, `set_option`), das Ein- und Ausschalten der
//! Fernsteuerung und der Wechsel ihrer Betriebsart. Dort ist der Sprung die
//! erwartete Antwort auf eine Handlung, und ein Uebergang von einer
//! Viertelsekunde liesse den Schalter traege wirken.

use std::time::Duration;

use super::{Ausgabetakt, VORHALT_MAX_MS};

/// Hoechster Schritt je eingereihtem Bild.
///
/// 1 ms bei 60 fps (16,7 ms Bildabstand) sind rund 6 % Abweichung von der
/// Senderuhr. Bei hoeherer Bildrate begrenzt [`ANTEIL`] den Schritt weiter,
/// damit die Abweichung nicht mit der Bildrate waechst.
const SCHRITT_MAX: Duration = Duration::from_millis(1);

/// Der Schritt ist hoechstens ein Sechzehntel des Bildabstands (rund 6 %).
///
/// Ohne diese Grenze waeren 1 ms bei 240 fps (4,2 ms Bildabstand) ein
/// Viertel — die Stufe ginge zwar schneller durch, aber die Bildfolge liefe
/// dabei sichtbar ungleich. So dauert eine 15-ms-Stufe bei jeder Bildrate
/// ueber 60 fps rund 250 ms.
const ANTEIL: u32 = 16;

impl Ausgabetakt {
    /// Ein neues Ziel fuer den Vorhalt — der Weg des REGLERS.
    ///
    /// Setzt weder die Untergrenze neu (das ist der Weg des Nutzers,
    /// `setze_vorhalt`) noch den Anker zurueck. Den Rest erledigt
    /// [`Self::gleiten`] Bild fuer Bild.
    pub(super) fn ziel_setzen(&mut self, ms: u32) {
        self.vorhalt_ziel = Duration::from_millis(u64::from(ms.min(VORHALT_MAX_MS)));
        self.regler_stufen += 1;
    }

    /// Wie weit der Vorhalt bei diesem Bild hoechstens ruecken darf.
    fn gleitschritt(&self) -> Duration {
        match self.bildabstand.filter(|d| !d.is_zero()) {
            Some(abstand) => SCHRITT_MAX.min(abstand / ANTEIL),
            None => SCHRITT_MAX,
        }
    }

    /// Den Vorhalt einen Schritt naeher an sein Ziel bringen. Gerufen aus
    /// `einreihen`, je Bild genau einmal.
    ///
    /// **Der Anker wandert um die Aenderung des WIRKSAMEN Vorhalts**, nicht
    /// des eingestellten: nur der wirksame steckt in den Zielzeitpunkten (s.
    /// `ziel`). Liegt der eingestellte ueber dem, was die Warteschlange traegt,
    /// aendert ein Schritt am wirksamen nichts — und dann darf auch der Anker
    /// nicht wandern.
    pub(super) fn gleiten(&mut self) {
        if self.vorhalt == self.vorhalt_ziel {
            return;
        }
        let schritt = self.gleitschritt();
        let vorher = self.wirksamer_vorhalt();
        self.vorhalt = if self.vorhalt_ziel > self.vorhalt {
            (self.vorhalt + schritt).min(self.vorhalt_ziel)
        } else {
            self.vorhalt.saturating_sub(schritt).max(self.vorhalt_ziel)
        };
        let nachher = self.wirksamer_vorhalt();
        if let Some(a) = self.anker.as_mut() {
            if nachher > vorher {
                a.lokal += nachher - vorher;
            } else if let Some(frueher) = a.lokal.checked_sub(vorher - nachher) {
                a.lokal = frueher;
            }
        }
        // Angekommen: der neue Wert darf seine Platz-Warnung wieder ausloesen
        // (dieselbe Regel wie in `vorhalt_anwenden`). Nicht je Schritt, sonst
        // kaeme sie bis zu fuenfzehnmal je Stufe.
        if self.vorhalt == self.vorhalt_ziel {
            self.gewarnt = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::decode::{DecodedFrame, PixelLayout};

    fn bild(rtp: u32) -> Box<DecodedFrame> {
        let mut f = DecodedFrame::for_test(
            2, 2, vec![vec![0; 4], vec![0; 1], vec![0; 1]], vec![2, 1, 1], false, PixelLayout::Planar420,
        );
        f.rtp_ts = Some(rtp);
        f.clock_rate = 90_000;
        Box::new(f)
    }

    /// 60 fps mit gleichbleibender Laufzeit; die Fenster-Schleife wacht genau
    /// zu jedem Termin auf. Liefert die Termine der gezeigten Bilder, die
    /// Zahl der uebersprungenen und den hoechsten gesehenen Vorhalt.
    ///
    /// `stoerung(k)` sagt, wie viele zu spaete Bilder vor Bild `k` dem Zaehler
    /// zugeschlagen werden — so loest der ECHTE Regler aus, ohne dass Bilder
    /// wirklich zu spaet kommen muessen (er liest nur den Zaehler).
    /// `verzug(k)` verschiebt die Ankunft von Bild `k` gegen die Senderuhr,
    /// `vorher(takt, k)` greift vor dem Einreihen ein.
    fn lauf(
        takt: &mut Ausgabetakt,
        bilder: u32,
        stoerung: impl Fn(u32) -> u64,
        verzug: impl Fn(u32) -> Duration,
        vorher: impl Fn(&mut Ausgabetakt, u32),
    ) -> (Vec<Instant>, u64, u64) {
        let t0 = Instant::now();
        let abstand = Duration::from_micros(16_667);
        let mut termine = Vec::new();
        let mut uebersprungen = 0;
        let mut hoechster = 0;
        for k in 0..bilder {
            let jetzt = t0 + abstand * k + verzug(k);
            takt.verspaetet += stoerung(k);
            vorher(takt, k);
            takt.einreihen(bild(k * 1500), jetzt);
            hoechster = hoechster.max(takt.vorhalt_ms());
            let naechste_ankunft = t0 + abstand * (k + 1) + verzug(k + 1);
            while let Some(t) = takt.naechster_termin().filter(|t| *t < naechste_ankunft) {
                let (f, weg) = takt.faellig(t);
                uebersprungen += weg;
                if f.is_some() {
                    termine.push(t);
                }
            }
        }
        (termine, uebersprungen, hoechster)
    }

    /// Zwei aufeinanderfolgende Termine liegen nie mehr als 2 ms neben dem
    /// Bildabstand.
    fn kein_sprung(termine: &[Instant]) {
        let soll = Duration::from_micros(16_667);
        for paar in termine.windows(2) {
            let d = paar[1].duration_since(paar[0]);
            let abweichung = d.abs_diff(soll);
            assert!(
                abweichung <= Duration::from_millis(2),
                "Sprung zwischen zwei Terminen: {d:?} statt {soll:?}"
            );
        }
    }

    /// **Die Zusage dieses Moduls.** Eine Reglerstufe 30 → 45 → 30 kostet
    /// keinen Bild-Termin und keinen Sprung: zwei aufeinanderfolgende Termine
    /// liegen nie mehr als 2 ms neben dem Bildabstand.
    ///
    /// Mit dem alten Weg (`vorhalt_anwenden` aus dem Regler) faellt der Test
    /// an beiden Stellen: die wartenden Bilder werden alle zugleich faellig
    /// (uebersprungen > 0), und das naechste steht den ganzen neuen Vorhalt.
    #[test]
    fn eine_reglerstufe_hin_und_zurueck_ruckt_nicht() {
        let mut takt = Ausgabetakt::neu(30);
        // Im ersten Fenster (0-2 s) 20 zu spaete Bilder → 10/s → Ziel 45.
        // Danach Ruhe; nach drei ruhigen Fenstern geht es auf 30 zurueck.
        let (termine, uebersprungen, hoechster) = lauf(
            &mut takt,
            60 * 12,
            |k| if k == 60 { 20 } else { 0 },
            |_| Duration::ZERO,
            |_, _| {},
        );
        assert_eq!(hoechster, 45, "der Regler muss wirklich auf 45 gegangen sein");
        assert_eq!(takt.vorhalt_ms(), 30, "und wieder zurueck");
        assert_eq!(takt.regler_stufen(), 2);
        assert_eq!(uebersprungen, 0, "kein Bild-Termin darf verloren gehen");
        assert_eq!(
            termine.len() + takt.warteschlange.len(),
            60 * 12,
            "jedes Bild muss gezeigt worden sein oder noch auf seinen Termin warten"
        );
        kein_sprung(&termine);
    }

    /// **Senken auf einer schwankenden Leitung.** Nur jedes zwanzigste Bild
    /// kommt mit der kuerzesten Laufzeit, die anderen 10 ms spaeter. Ueberliesse
    /// man das Senken dem Nachziehen (Modulkopf), stuende der Anker, bis das
    /// naechste schnelle Bild kommt, und zoege dann um alles Aufgelaufene auf
    /// einmal nach — in der Gegenprobe ein Sprung von 11 ms. Mit dem mitwandernden
    /// Anker bleibt jeder Schritt bei hoechstens 1 ms.
    #[test]
    fn senken_auf_schwankender_leitung_springt_nicht() {
        let mut takt = Ausgabetakt::neu(45);
        let (termine, uebersprungen, _) = lauf(
            &mut takt,
            120,
            |_| 0,
            |k| if k % 20 == 0 { Duration::ZERO } else { Duration::from_millis(10) },
            |t, k| {
                if k == 30 {
                    t.ziel_setzen(30);
                }
            },
        );
        assert_eq!(takt.vorhalt_ms(), 30);
        assert_eq!(uebersprungen, 0);
        kein_sprung(&termine);
    }

    /// Ein von Hand gesetzter Wert beendet einen laufenden Uebergang und gilt
    /// sofort — gleiten darf nur der Regler.
    #[test]
    fn handbedienung_beendet_den_uebergang() {
        let mut takt = Ausgabetakt::neu(30);
        takt.ziel_setzen(45);
        takt.gleiten();
        assert_eq!(takt.vorhalt_ms(), 31, "ein Schritt");
        takt.setze_vorhalt(60);
        assert_eq!(takt.vorhalt_ms(), 60);
        assert_eq!(takt.vorhalt_ziel_ms(), 60);
        takt.gleiten();
        assert_eq!(takt.vorhalt_ms(), 60, "kein Uebergang mehr");
    }

    /// Steht der Zwischenstand zufaellig schon auf dem Handwert, endet der
    /// Uebergang trotzdem — sonst glitte der Vorhalt danach am Wunsch vorbei.
    #[test]
    fn handwert_gleich_dem_zwischenstand_beendet_den_uebergang_auch() {
        let mut takt = Ausgabetakt::neu(30);
        takt.ziel_setzen(45);
        takt.gleiten();
        takt.setze_vorhalt(31);
        for _ in 0..20 {
            takt.gleiten();
        }
        assert_eq!(takt.vorhalt_ms(), 31);
        assert_eq!(takt.vorhalt_ziel_ms(), 31);
    }

    /// Bei hoher Bildrate wird der Schritt kleiner, damit die Bildfolge nicht
    /// ungleicher laeuft als bei 60 fps.
    #[test]
    fn der_schritt_folgt_dem_bildabstand() {
        let mut takt = Ausgabetakt::neu(30);
        assert_eq!(takt.gleitschritt(), SCHRITT_MAX, "ohne bekannte Bildrate");
        takt.bildabstand = Some(Duration::from_micros(4_167)); // 240 fps
        assert!(takt.gleitschritt() < Duration::from_micros(300));
        takt.bildabstand = Some(Duration::from_micros(33_333)); // 30 fps
        assert_eq!(takt.gleitschritt(), SCHRITT_MAX, "nie mehr als 1 ms");
    }
}
