//! Die Zeitbasis der Bildspur — in welcher Einheit ein Bild sagt, wann es
//! entstanden ist.
//!
//! **Seit dem 2026-08-20 gemeinsam fuer alle drei Sidecars.** Vorher lag diese
//! Rechnung dreimal vor. Am 2026-08-17 sind zwei der Fassungen unbemerkt
//! auseinandergelaufen — folgenlos nur durch Zufall, weil es Kommentarzeilen
//! traf. Genau dafuer gibt es diese Crate.
//!
//! ## Warum das eine eigene Datei wert ist
//!
//! **Bis 2026-08-14 war die Einheit ein BILDPLATZ** (`1/fps`): der Zeitstempel
//! eines Bildes konnte nur Vielfache eines Bildabstands ausdruecken, bei 60 fps
//! also 0, 16,7, 33,3 ms. Das ist genau so lange richtig, wie die Bilder auch
//! wirklich in diesem Raster entstehen — und das tun sie fast nie.
//!
//! Ein Bildschirm liefert neue Bilder nur zu seinen eigenen Zeitpunkten. Bei
//! 143,9 Hz sind das alle 6,95 ms. Wer daraus 60 Bilder je Sekunde abtastet,
//! bekommt sie im Muster 2-2-3 Bildschirmtakte, also mit Abstaenden von 13,9 /
//! 13,9 / 20,8 ms — nicht 16,7. Die Zahl der Bilder stimmt, ihre ABSTAENDE
//! nicht, und das ist kein Fehler, sondern Arithmetik: 143,9 geteilt durch 60
//! ist 2,4, und 2,4 Bildschirmtakte kann niemand abwarten.
//!
//! Im alten Raster ging diese Ungleichmaessigkeit beim Runden verloren. Der
//! Zuschauer bekam Bilder, die 13,9 ms auseinander aufgenommen wurden, als
//! waeren es 16,7 — die Bewegung lief also abwechselnd zu langsam und zu
//! schnell, obwohl jede Zahl im System gesund aussah. Genau das ist der Rest
//! Unruhe, der nach dem Beheben der Doppelbilder (Aufnahme-Deckel) uebrig
//! bleibt.
//!
//! Mit 90 kHz ist ein Takt 11 Mikrosekunden lang. Die 2-2-3-Abstaende kommen
//! damit als 1251 / 1251 / 1876 Takte heraus — ehrlich, statt dreimal 1500.
//!
//! ## Warum ausgerechnet 90 kHz
//!
//! Weil es die Uhr ist, die am Ende der Leitung ohnehin zaehlt: RTP fuehrt
//! Video seit jeher mit 90 kHz, und der Wert wird im SDP als `clock_rate`
//! angemeldet (`pulse_whip::av1::RTP_TAKT_HZ` — diese Crate hat keine
//! Abhaengigkeiten, deshalb kein anklickbarer Intra-Doc-Link ueber die
//! Crate-Grenze). Encoder- und RTP-Zeitbasis
//! gleichzusetzen macht die Umrechnung im Sendeweg zur Identitaet — und eine
//! Umrechnung, die es nicht gibt, kann auch nicht falsch runden. Auf dem
//! Muxer-Weg (RTMPS/Datei) rechnet FFmpeg selbst nach `stream_time_base` um;
//! FLV kann nur Millisekunden, das ist bei 60 fps immer noch sechzehnmal
//! feiner als ein Bildplatz.
//!
//! Mikrosekunden waeren die andere naheliegende Wahl und haetten denselben
//! Zweck erfuellt. 90 kHz gewinnt, weil es die Identitaet oben schenkt.
//!
//! ## Was diese Datei NICHT aendert
//!
//! Die Bildrate selbst. Der Encoder bekommt sie weiterhin ausdruecklich als
//! `set_frame_rate` mit — daran haengen Ratenregelung und GOP-Laenge, und
//! beide sollen sich nicht ruehren. Die Zeitbasis sagt nur, in welcher Einheit
//! ein Zeitstempel gemessen wird, nicht wie oft ein Bild kommt.

/// Takte je Sekunde der Video-Zeitbasis. **Gleich der RTP-Uhr** — die
/// Gleichheit ist Absicht und der Grund fuer die Wahl (s. Modulkopf).
pub const VIDEO_HZ: u32 = 90_000;

/// Aufnahmezeit in Sekunden seit Streambeginn → pts in Takten.
///
/// Negative Eingaben (ein Bild, das minimal VOR dem Streambeginn entstand)
/// kommen als 0 heraus statt als negativer Zeitstempel — der Aufrufer haelt
/// die Monotonie ohnehin, aber ein negativer pts waere schon auf dem Weg
/// dorthin eine Falle.
pub fn pts_aus_sekunden(sekunden: f64) -> i64 {
    if !sekunden.is_finite() || sekunden <= 0.0 {
        return 0;
    }
    (sekunden * f64::from(VIDEO_HZ)).round() as i64
}

/// Ein Bildabstand in Takten, aufgerundet.
///
/// Aufgerundet, weil jeder Nutzer unten eine UNTERGRENZE braucht („mindestens
/// so weit auseinander"): bei 60 fps sind 90000/60 glatt 1500, bei 144 aber
/// 625, und bei krummen Raten wie 30000/1001 liegt der echte Abstand
/// dazwischen. Abrunden liesse dort zwei Bilder als „weit genug auseinander"
/// durchgehen, die es nicht sind.
pub fn takte_je_bild(fps: u32) -> i64 {
    let fps = fps.max(1);
    (i64::from(VIDEO_HZ) + i64::from(fps) - 1) / i64::from(fps)
}

/// Ab welchem pts-Sprung von einer LUECKE zu reden ist — also von einem Bild,
/// das ausgefallen ist, und nicht von der normalen Ungleichmaessigkeit der
/// Abtastung.
///
/// **Diese Zahl gab es im alten Raster nicht**, dort war jeder Sprung ueber
/// einen Bildplatz eine Luecke, und das war richtig: im Raster konnte es keine
/// Zwischenwerte geben. Mit ehrlichen Zeitstempeln sind die Zwischenwerte der
/// Normalfall. Wer hier weiter bei „mehr als ein Bildabstand" zaehlte, meldete
/// zwanzigmal je Sekunde eine Luecke, die keine ist.
///
/// **Wie gross die Schwankung wirklich wird, ist gemessen** — sie haengt am
/// Verhaeltnis `r = Wiederholrate / fps` und betraegt hoechstens `ceil(r)/r`
/// Bildabstaende. Am 2026-08-14 ueber je 27 s, fehlerfreie Ausgabe (0
/// Duplikate, 0 Verwuerfe):
///
/// | Ziel | groesster echter Abstand |
/// |---|---|
/// | 30 fps | 1,25 Bildabstaende |
/// | 60 fps | 1,25 |
/// | 120 fps | **1,67** |
/// | 144 fps | **2,00** |
///
/// **Anderthalb waeren also falsch gewesen** — genau das stand hier zuerst,
/// hergeleitet aus dem 60-fps-Fall allein, und haette bei 120 fps 640 von 3202
/// Ticks als Luecke gemeldet. Je naeher die Zielrate an die Wiederholrate
/// rueckt, desto groesser wird die Schwankung: fuer `r → 1` geht `ceil(r)/r`
/// gegen 2.
///
/// **Was diese Zahl deshalb NICHT mehr kann:** ein EINZELNES ausgefallenes
/// Bild von der Abtast-Schwankung trennen, wenn Zielrate und Wiederholrate
/// dicht beieinanderliegen — beide landen dann bei rund zwei Bildabstaenden.
/// Dafuer ist die plattformeigene Tick-Ueberwachung des jeweiligen Sidecars
/// zustaendig (unter Windows der `tick_monitor`, unter Linux der
/// `duplicates`-Zaehler im Zeitachse-Log des `stream_controller`), und die
/// misst es direkt statt es aus der Zeitachse zu erraten. Diese Schwelle
/// meldet einen STILLSTAND ueber mehr als zwei Bilder — grob, aber nicht
/// falsch.
pub fn lueckenschwelle(fps: u32) -> i64 {
    takte_je_bild(fps) * 2
}

/// pts eines Duplikats (die Quelle steht still, es wird das letzte Bild
/// erneut gesendet). `uhr_pts` ist JETZT auf derselben Uhr wie die echten
/// Bilder (`pts_aus_sekunden(jetzt - ursprung)`).
///
/// **Zaehler mit Uhr als Untergrenze.** Ein Duplikat hat keine eigene
/// Aufnahmezeit, deshalb geht es grundsaetzlich einen Bildabstand weiter
/// (sonst schrumpft ein Standbild auf Millisekunden). Der Zaehler allein
/// rechnet aber mit dem SOLL-Abstand, und der Herzschlag kommt nie genau
/// puenktlich: jede Aufwach-Verspaetung und jedes Stocken fehlte ihm fuer
/// immer. Am 2026-10-20 lag der Zeitstempel so nach Sekunden Standbild
/// Hunderte Millisekunden hinter der Uhr, bis das naechste echte Bild ihn
/// zurueckriss (Tests unten). Deshalb darf ein Duplikat hoechstens einen
/// Bildabstand hinter der Uhr liegen.
///
/// **Warum einen Bildabstand dahinter und nicht auf der Uhr:** ein echtes
/// Bild, das kurz vor dem Herzschlag aufgenommen wurde, kann erst danach
/// ankommen. Laege das Duplikat schon auf „jetzt", haette dieses Bild einen
/// kleineren Zeitstempel als sein Vorgaenger und muesste geklemmt werden —
/// die Dauer-Klemmung, die die Messung vom 2026-08-14 bei an die Uhr
/// gehefteten Duplikaten gezeigt hat.
pub fn duplikat_pts(last_pts: i64, takte_je_bild: i64, uhr_pts: i64) -> i64 {
    (last_pts + takte_je_bild).max(uhr_pts - takte_je_bild)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eine_sekunde_sind_neunzigtausend_takte() {
        assert_eq!(pts_aus_sekunden(1.0), 90_000);
        assert_eq!(pts_aus_sekunden(0.5), 45_000);
    }

    /// Der Kern der ganzen Datei: die 2-2-3-Abtastung eines 144-Hz-Schirms
    /// muss als DREI VERSCHIEDENE Abstaende herauskommen. Im alten Raster
    /// (1/fps) waren alle drei 1 — genau der Verlust, um den es geht.
    #[test]
    fn ungleiche_abstaende_bleiben_ungleich() {
        let takt = 1.0 / 143.9; // ein Bildschirmtakt
        let p: Vec<i64> = [0.0, 2.0, 4.0, 7.0, 9.0]
            .iter()
            .map(|n| pts_aus_sekunden(n * takt))
            .collect();
        let abstaende: Vec<i64> = p.windows(2).map(|w| w[1] - w[0]).collect();
        assert_eq!(abstaende, vec![1251, 1251, 1876, 1251]);
        // Und keiner davon ist ein glatter Bildabstand bei 60 fps (1500).
        assert!(abstaende.iter().all(|&a| a != takte_je_bild(60)));
    }

    #[test]
    fn negative_und_kaputte_zeiten_werden_null() {
        assert_eq!(pts_aus_sekunden(-0.001), 0);
        assert_eq!(pts_aus_sekunden(f64::NAN), 0);
    }

    /// Aufrunden, nicht abrunden — sonst ist die Untergrenze keine.
    #[test]
    fn bildabstand_rundet_auf() {
        assert_eq!(takte_je_bild(60), 1_500);
        assert_eq!(takte_je_bild(144), 625);
        assert_eq!(takte_je_bild(280), 322, "90000/280 ist 321,4");
        assert_eq!(takte_je_bild(0), 90_000, "keine Division durch null");
    }

    /// Die Schwelle muss ueber der groessten ECHTEN Abtast-Schwankung liegen.
    /// Die Werte sind gemessen (Tabelle an [`lueckenschwelle`]) — 1,67
    /// Bildabstaende bei 120 fps und 2,00 bei 144 fps auf einem 143,9-Hz-
    /// Schirm, jeweils bei fehlerfreier Ausgabe. Anderthalb Bildabstaende
    /// standen hier zuerst und haetten beide als Luecke gezaehlt.
    #[test]
    fn echte_abtast_schwankung_zaehlt_nicht_als_luecke() {
        for (fps, groesste) in [(30u32, 1.25), (60, 1.25), (120, 1.67), (144, 2.00)] {
            let gemessen = (f64::from(takte_je_bild(fps) as u32) * groesste) as i64;
            assert!(
                gemessen <= lueckenschwelle(fps),
                "{fps} fps: {groesste} Bildabstaende sind normal, wuerden aber zaehlen"
            );
        }
    }

    /// Und ein echter Stillstand ueber mehr als zwei Bilder zaehlt weiterhin.
    #[test]
    fn stillstand_ueber_zwei_bilder_zaehlt() {
        assert!(takte_je_bild(60) * 3 > lueckenschwelle(60));
    }

    /// Faehrt eine Strecke aus lauter Duplikaten: der Herzschlag kommt alle
    /// `abstand_s` Sekunden (bei der Fernsteuerung einen Bildabstand plus die
    /// Aufwach-Verspaetung), dazu optional ein Stocken. Liefert alle pts und
    /// die Uhr beim letzten.
    fn duplikat_strecke(
        abstand_s: f64,
        n: usize,
        stocken_bei: Option<(usize, f64)>,
    ) -> (Vec<i64>, i64) {
        let f = takte_je_bild(60);
        let mut uhr_s = 0.0;
        let mut pts = vec![0i64];
        for i in 1..n {
            uhr_s += abstand_s;
            if let Some((bei, dauer)) = stocken_bei
                && i == bei
            {
                uhr_s += dauer;
            }
            let letzter = *pts.last().unwrap();
            pts.push(duplikat_pts(letzter, f, pts_aus_sekunden(uhr_s)));
        }
        (pts, pts_aus_sekunden(uhr_s))
    }

    /// **Der Fehler vom 2026-10-20** (Fernsteuerung, Windows, all3media): der
    /// Herzschlag kam im Mittel 0,6 ms zu spaet (57,9 statt 60 Bilder/s), der
    /// Zaehler rechnete aber glatte 16,7 ms. Nach zehn Sekunden Standbild lag
    /// der Zeitstempel ~360 ms hinter der Uhr — der Player hielt die Bilder
    /// fuer verspaetet und schob seinen Vorhalt zwischen 30 und 105 ms hin
    /// und her, der Ton blieb stehen: Bild und Ton liefen auseinander.
    #[test]
    fn duplikate_fallen_nicht_hinter_die_uhr() {
        let abstand = 1.0 / 57.9;
        let (pts, uhr) = duplikat_strecke(abstand, 579, None);
        let rueckstand = uhr - *pts.last().unwrap();
        assert!(
            rueckstand <= takte_je_bild(60),
            "nach 10 s Standbild {} ms hinter der Uhr",
            rueckstand / 90
        );
    }

    /// Ein Stocken des Senders (gemessen bis 278 ms) darf ebenso keinen
    /// bleibenden Rueckstand hinterlassen — die Luecke gehoert in den
    /// Zeitstempel, sie ist ja wirklich passiert.
    #[test]
    fn stocken_hinterlaesst_keinen_rueckstand() {
        let (pts, uhr) = duplikat_strecke(1.0 / 60.0, 120, Some((60, 0.278)));
        assert!(uhr - *pts.last().unwrap() <= takte_je_bild(60));
    }

    /// Die andere Falle (Messung 2026-08-14): ein Duplikat ist mindestens
    /// einen Bildabstand weiter, sonst schrumpft ein Standbild im Strom auf
    /// Millisekunden. Gilt auch, wenn die Uhr GAR NICHT weiterliefe.
    #[test]
    fn duplikate_halten_mindestens_einen_bildabstand() {
        let f = takte_je_bild(60);
        for uhr in [0, 1_000, 5_000] {
            assert_eq!(duplikat_pts(5_000, f, uhr), 5_000 + f);
        }
        let (pts, _) = duplikat_strecke(1.0 / 70.0, 300, None);
        assert!(pts.windows(2).all(|w| w[1] - w[0] >= f));
    }

    /// Und die dritte (Dauer-Klemmung, ebenfalls 2026-08-14): an die Uhr
    /// geheftete Duplikate liefen VOR die Aufnahmezeit des naechsten echten
    /// Bildes, das dann nur noch geklemmt werden konnte. Deshalb bleibt ein
    /// Duplikat einen Bildabstand HINTER der Uhr: ein echtes Bild, das bis zu
    /// einem Bildabstand vor dem Herzschlag aufgenommen wurde und erst danach
    /// ankommt, behaelt seine Aufnahmezeit.
    #[test]
    fn duplikat_laesst_dem_naechsten_echten_bild_platz() {
        let f = takte_je_bild(60);
        let uhr = 900_000;
        let dup = duplikat_pts(0, f, uhr);
        assert_eq!(dup, uhr - f);
        let echtes_bild_kurz_davor = uhr - f / 2;
        assert!(echtes_bild_kurz_davor > dup);
    }
}
