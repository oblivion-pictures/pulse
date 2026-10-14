//! Verspäteten Ton nach einem Unterlauf verwerfen, statt ihn hinten anzuhängen.
//!
//! **Der Befund** (Fernsteuerung, Windows-Sender, 10-ms-Opus, verlustbehaftete
//! Leitung, Log vom 2026-10-14): nach jedem kleinen Lieferaussetzer lief der
//! Ring leer, das Gerät spielte Stille. Danach kam der verpasste Ton gesammelt
//! an — zusammen mit dem pünktlichen — und wurde HINTEN angehängt. Der Ring
//! stand anschließend bei 110–135 ms statt beim Sollwert 60 ms, unter der
//! Kappschwelle (180 ms), also ohne Schnitt; der Uhrenabgleich baut am Anschlag
//! 1 ms je Sekunde ab. Der Ton lief bis zu eine Minute 60–90 ms hinter dem
//! Bild, und der nächste Aussetzer kam meist vorher.
//!
//! **Das Kriterium.** Die Tonuhr weiß, welche RTP-Position JETZT klingen müsste
//! ([`super::lippen::Tonuhr::position`]); der Ausgabezähler läuft auch während
//! der Stille weiter (`fill_output`). Ein Paket, dessen RTP-Bereich vor dieser
//! Position liegt, ist für eine Zeit bestimmt, in der schon Stille lief:
//! ganz davor → ganz weg, teilweise → der Anfang weg (ganze Frames).
//!
//! **Nur nach einem Unterlauf** (Ring leer, Ausgabe im Anlauf). Gerechnet, an
//! `Tonuhr::paket`/`position`: solange der Ring ohne Unterbrechung abläuft,
//! liegt ein neues Paket um genau den Ringfüllstand vor dem Anhängen vor der
//! Position (bis auf die Umrechner-Rundung) — es KANN dann nicht verspätet
//! sein. Wo die Position von der Wirklichkeit abweicht, ist das Vorfüllen mit
//! nichtleerem Ring: da steht der Ring, die Position läuft trotzdem weiter
//! (bis zum nächsten `paket`). Ein Vergleich dort schnitte normalen
//! Ankunftsjitter aus Ton, der noch gar nicht klingt. Mit leerem Ring dagegen
//! hat das Gerät allen Vorrat gespielt, und alles, was die Position seitdem
//! weiterlief, war hörbare Stille.
//!
//! **Beim Start nicht**: ohne Tonuhr (erstes Paket) gibt es keine Position,
//! und Vorfüllen beim Start ist keine verpasste Zeit.
//!
//! **Eine feste Grenze je Unterlauf, keine mitlaufende Position.** Die Grenze
//! wird beim ersten Paket nach dem Leerlaufen gesetzt (Position in diesem
//! Augenblick) und gilt, bis ein Paket (teilweise) behalten wird. Mit der
//! mitlaufenden Position gäbe es eine Endlosschleife: bei einem Latenzsprung
//! (jedes Paket kommt dauerhaft 40 ms später) läge jedes Paket hinter der
//! Position, würde verworfen, der Ring bliebe leer, die Position liefe weiter —
//! Stille ohne Ende. Mit fester Grenze ist der Verwurf je Unterlauf auf die
//! Verspätung des ersten Nachzüglers begrenzt; danach läuft das normale
//! Vorfüllen bis zum Sollwert. Ein Nachhol-Schwall kommt — angenommen wie an
//! `ringregelung::SCHWALL_RUHE`, nicht gemessen — in wenigen Millisekunden an,
//! da ist die feste Grenze von der mitlaufenden Position nicht zu
//! unterscheiden.
//!
//! **Was es kostet** (gerechnet, nicht gemessen): bei einem echten Latenzsprung
//! bringt das Verwerfen nichts — der Ton muss danach ohnehin um den Sprung
//! später klingen —, verliert aber einmalig die Verspätung des ersten
//! Nachzüglers an Ton und hängt dieselbe Zeit Stille an. Kommt der Nachschub
//! nach dem Aussetzer gleichmäßig statt gesammelt, gleicht das Vorfüllen den
//! Versatz auch ohne Verwerfen aus (der Ring läuft erst mit dem Sollwert an);
//! verworfen wird dann nur die Verspätung des ersten Pakets. Gewonnen wird
//! beim Schwall: ohne Verwerfen bliebe genau die Länge der Stille als Versatz
//! im Ring stehen.
//!
//! **Sender-Pause** (RTP springt nach vorn): das erste Paket danach liegt der
//! Position voraus, nichts wird verworfen.
//!
//! **Älter als das zuletzt vermessene Paket** (umsortiert, doppelt, später
//! auch reparierter Ton aus einer Redundanz): immer ganz weg, nicht nur nach
//! einem Unterlauf. Sein Platz im Ring ist vergeben — angehängt klänge es nach
//! neuerem Ton —, und `Tonuhr::paket` läse den Rückschritt mit seiner
//! vorzeichenlosen Wrap-Rechnung als Sprung um 2^32 Takte (rund 24,8 h) nach
//! vorn; der Lippen-Fehler wäre danach Unsinn. Liegt es mehr als
//! [`VERSPAETUNG_MAX_MS`] zurück, ist es ein Bruch der Zeitbasis: dann wird
//! die Tonuhr verworfen und am Paket neu verankert (Rest: ihr Start-Vorhalt
//! ist dann der Sollwert MIT dem Lippen-Eingriff, `fuetterung.rs`).
//!
//! **Nachlauf: der Rest, den die Positionsrechnung nicht sieht** (Nachprüfung
//! 2026-10-14, nachgerechnet). Geprüft wird nur bei leerem Ring. Reißt die
//! Lieferung ein zweites Mal ab, während der Ring noch vorfüllt (Füllstand
//! zwischen null und Sollwert), schweigt das Gerät, die Position läuft weiter,
//! und der Schwall danach wird ungeprüft angehängt; ebenso, wenn der Nachschub
//! erst NACH dem Anlauf in Raten aufholt. Der Ring steht dann deutlich über
//! dem Sollwert und doch unter der Kappschwelle (nachgestellt in
//! `audio/tests.rs`, Szenarien A–C: 60–110 ms darüber). Deshalb liegt die
//! Kappschwelle bis [`NACHLAUF`] nach dem letzten Paket im Anlauf tiefer, bei
//! Sollwert plus [`NACHLAUF_RUECKSTAND_MS`] (`Shared::kapp_schwelle`): die
//! bestehende Grobkappung schneidet den Überstand, sobald der Schwall vorbei
//! ist (`ringregelung::SCHWALL_RUHE`), auf den Sollwert — älteste Samples
//! zuerst; gezählt als Schnitt (`dropped`, „Schnitte“ in der Statistikzeile).
//! Bei gleichmäßigem Nachschub steigt der Ring nicht über den Sollwert plus
//! ein Paket (gerechnet) und es wird nichts geschnitten.
//!
//! **Warum nicht NUR der Nachlauf** (er fängt den Hauptfall auch): er
//! schneidet frühestens nach der Ruhezeit, bis dahin klingt der verspätete Ton
//! schon, und der Schnitt ist ein hörbarer Sprung. Das Verwerfen per Position
//! nimmt den Hauptfall — jeder Aussetzer im Befund — vor dem ersten Sample
//! heraus. Und eine Kappung genau beim Ende des Anlaufs (im Geräte-Rückruf)
//! verfehlte den Teil eines Schwalls, der erst nach dem Anlaufen ankommt: der
//! Rückruf kann mitten in einen Schwall fallen, und Raten-Aufholen nach dem
//! Anlauf sieht sie gar nicht.
//!
//! **Buchführung.** Der verworfene Anfang erreicht weder Ring noch Kappung,
//! Uhrenabgleich oder Lippen-Vermessung — die sehen nur den Rest, dessen Marke
//! um die verworfenen Takte weitergerückt ist (`Tonuhr::paket`). Gezählt wird
//! er in `dropped` und eigens in [`Nachzuegler::verworfen`] (Statistikzeile
//! „davon verspaetet“). Ein `Uhrenabgleich::neu_beginnen` braucht es nicht:
//! während des Aussetzers kamen keine Pakete, sein Mittel stammt aus der Zeit
//! davor, und der Ring steht danach wieder etwa dort — genau auf dem Sollwert
//! nur, wenn der Vorrat beim Aussetzer es war; fehlt etwas, füllt das
//! Vorfüllen es wie gehabt auf.

use std::time::{Duration, Instant};

use super::ringregelung::RING_SOLL_MS;
use super::Shared;

/// Wie viel ein Paket mindestens hinter der Position liegen muss, damit
/// überhaupt verworfen wird, in Millisekunden.
///
/// Die Position ist nicht auf die Probe genau: der Umrechner (`opus.rs`,
/// `flags=res`) hält Samples zurück, und die Uhren-Nachführung verschiebt die
/// Zahl je Paket um Bruchteile. Beides liegt — angenommen nach Filterlänge und
/// ±1000 ppm, nicht gemessen — unter einer Millisekunde. Zwei Millisekunden
/// Restversatz sind gegenüber den 60–90 ms des Befunds bedeutungslos.
const TOLERANZ_MS: i64 = 2;

/// Ab welcher Verspätung ein Paket kein Nachzügler mehr ist, sondern ein Bruch
/// der Zeitbasis (neuer Sender, RTP-Sprung rückwärts), in Millisekunden.
///
/// Ohne diese Grenze verwürfe die feste Grenze alles, bis die Marken sie
/// wieder eingeholt haben — bei einem Rücksprung um Stunden also stundenlang
/// Stille. Ein echter Rückstand über einer Sekunde ist ohnehin Sache der
/// Grobkappung (`ringregelung`), die ihn nach dem Schwall wegschneidet.
const VERSPAETUNG_MAX_MS: i64 = 1000;

/// RTP-Takte je Millisekunde — Opus über RTP läuft immer mit 48 kHz.
const TAKTE_JE_MS: i64 = 48;

/// Wie lange nach dem letzten Paket im Anlauf die tiefere Kappschwelle gilt.
///
/// Angenommen, nicht gemessen: ein Aufholen nach einem Aussetzer ist binnen
/// weniger hundert Millisekunden vorbei. Länger tiefer zu kappen hiesse, dass
/// auch Ankunftsjitter (mehrere Pakete auf einmal) geschnitten werden kann.
const NACHLAUF: Duration = Duration::from_secs(1);

/// Kappschwelle im Nachlauf: so viele Millisekunden über dem wirksamen
/// Sollwert. Halber Grundwert = 30 ms = drei 10-ms-Pakete; der Sägezahn im
/// gleichmäßigen Betrieb reicht bis Sollwert plus ein Paket (gerechnet). Die
/// Schwall-Toleranz der Grobkappung (`SCHWALL_TOLERANZ_TEILER`) beträgt damit
/// knapp 4 ms statt 15 ms.
const NACHLAUF_RUECKSTAND_MS: usize = RING_SOLL_MS / 2;

/// Zustand des Verwerfens. Liegt in `Shared`, gepflegt vom Fütter-Faden.
#[derive(Default)]
pub(super) struct Nachzuegler {
    /// RTP-Marke (verlängert, 48-k-Takte), vor der verworfen wird — gesetzt
    /// beim ersten Paket nach einem Leerlauf, gelöscht, sobald wieder etwas
    /// behalten wird. `None` = kein Unterlauf offen.
    grenze: Option<i64>,
    /// Verworfene verschränkte Samples (Gerätetakt), für die Statistikzeile.
    /// Steckt zusätzlich in `Shared::dropped`.
    pub(super) verworfen: u64,
    /// Bis wann die tiefere Kappschwelle gilt ([`NACHLAUF`]).
    nachlauf_bis: Option<Instant>,
}

impl Nachzuegler {
    /// Ein Paket kam, während die Ausgabe (wieder) anläuft — beim Start oder
    /// nach einem Unterlauf. Öffnet den Nachlauf.
    pub(super) fn im_anlauf(&mut self, jetzt: Instant) {
        self.nachlauf_bis = Some(jetzt + NACHLAUF);
    }

    /// Die Kappschwelle: im Nachlauf Sollwert plus [`NACHLAUF_RUECKSTAND_MS`],
    /// sonst `normal`. Nie höher als `normal`, nie am Sollwert selbst (dort
    /// schnitte die Grobkappung jeden Sägezahn).
    pub(super) fn kappschwelle(
        &self,
        normal: usize,
        soll: usize,
        per_ms: usize,
        jetzt: Instant,
    ) -> usize {
        match self.nachlauf_bis {
            Some(bis) if jetzt < bis => normal.min(soll + NACHLAUF_RUECKSTAND_MS * per_ms),
            _ => normal,
        }
    }

    /// Wie viele RTP-Takte vom Anfang dieses Pakets zu verwerfen sind
    /// (0 bis `takte`).
    ///
    /// `start` = verlängerte RTP-Marke des Pakets, `takte` = seine Länge in
    /// 48-k-Takten, `position` = was laut Tonuhr jetzt klingt,
    /// `leer_im_anlauf` = der Ring ist leer und die Ausgabe füllt nach einem
    /// Unterlauf vor.
    pub(super) fn pruefen(
        &mut self,
        start: i64,
        takte: i64,
        position: f64,
        leer_im_anlauf: bool,
    ) -> i64 {
        let grenze = match self.grenze {
            Some(grenze) => grenze,
            None => {
                if !leer_im_anlauf {
                    return 0;
                }
                let spaet = position - start as f64;
                if spaet < (TOLERANZ_MS * TAKTE_JE_MS) as f64
                    || spaet > (VERSPAETUNG_MAX_MS * TAKTE_JE_MS) as f64
                {
                    return 0;
                }
                let grenze = position.floor() as i64;
                self.grenze = Some(grenze);
                grenze
            }
        };
        let spaet = grenze - start;
        if spaet <= 0 || spaet > VERSPAETUNG_MAX_MS * TAKTE_JE_MS {
            // Eingeholt — oder ein Bruch der Zeitbasis (s. `VERSPAETUNG_MAX_MS`).
            self.grenze = None;
            return 0;
        }
        if spaet < takte {
            // Der Rest dieses Pakets bleibt: der Unterlauf ist abgearbeitet.
            self.grenze = None;
            return spaet;
        }
        takte
    }
}

/// Frames (Gerätetakt) in RTP-Takte (48 kHz), gerundet.
fn frames_in_takte(frames: usize, rate: u32) -> i64 {
    if rate == 0 {
        return 0;
    }
    ((frames as u64 * 48_000 + u64::from(rate) / 2) / u64::from(rate)) as i64
}

/// RTP-Takte (48 kHz) in Frames (Gerätetakt), gerundet.
fn takte_in_frames(takte: i64, rate: u32) -> usize {
    ((takte.max(0) as u64 * u64::from(rate) + 24_000) / 48_000) as usize
}

impl Shared {
    /// Den verspäteten Anfang eines Pakets verwerfen (s. Modulkopf), BEVOR es
    /// angehängt wird.
    ///
    /// `samples` = verschränktes PCM in Rate und Kanalzahl des Geräts. Gibt die
    /// RTP-Marke des behaltenen Rests zurück — um die verworfenen Takte
    /// weitergerückt, damit die Lippen-Vermessung (`Tonuhr::paket`) den Rest an
    /// der richtigen Stelle einträgt — oder `None`, wenn nichts übrig blieb.
    /// Verworfen werden nur ganze Frames: der Ring hält verschränktes PCM, ein
    /// halber Frame vertauschte die Kanäle.
    pub(super) fn verspaetetes_verwerfen(
        &mut self,
        samples: &mut Vec<f32>,
        rtp_roh: u32,
        rate: u32,
        kanaele: u16,
    ) -> Option<u32> {
        let kanaele_n = usize::from(kanaele.max(1));
        let frames = samples.len() / kanaele_n;
        let Some(uhr) = self.tonuhr.as_ref() else { return Some(rtp_roh) };
        if frames == 0 {
            return Some(rtp_roh);
        }
        let start = uhr.marke(rtp_roh);
        let rueck = uhr.zuletzt() - start;
        if rueck > VERSPAETUNG_MAX_MS * TAKTE_JE_MS {
            // Bruch der Zeitbasis: neu verankern (s. Modulkopf).
            self.tonuhr = None;
            self.nachzuegler.grenze = None;
            return Some(rtp_roh);
        }
        if rueck >= 0 {
            // Nicht neuer als das zuletzt vermessene Paket: ganz weg.
            return self.vorn_verwerfen(samples, frames, kanaele_n, rate, rtp_roh);
        }
        let position = uhr.position(self.ausgabe, rate, kanaele);
        let leer_im_anlauf = self.anlauf && self.ring.is_empty();
        let takte = frames_in_takte(frames, rate);
        let spaet = self.nachzuegler.pruefen(start, takte, position, leer_im_anlauf);
        // Ganz oder teilweise entscheidet `pruefen`, nicht die Rundung: bei
        // Geräteraten ungleich 48 kHz trifft die Rückrechnung in Frames nicht
        // genau — ein Ganzverwurf liesse sonst einen Frame stehen, ein
        // Teilverwurf leerte womöglich das Paket, obwohl `pruefen` die Grenze
        // schon für erledigt hält.
        let weg_frames = if spaet >= takte {
            frames
        } else {
            takte_in_frames(spaet, rate).min(frames - 1)
        };
        self.vorn_verwerfen(samples, weg_frames, kanaele_n, rate, rtp_roh)
    }

    /// `weg_frames` Frames vom Anfang des Pakets verwerfen und zählen. Gibt
    /// die RTP-Marke des Rests zurück (um die verworfenen Takte weiter), `None`
    /// wenn nichts übrig blieb.
    fn vorn_verwerfen(
        &mut self,
        samples: &mut Vec<f32>,
        weg_frames: usize,
        kanaele_n: usize,
        rate: u32,
        rtp_roh: u32,
    ) -> Option<u32> {
        if weg_frames == 0 {
            return Some(rtp_roh);
        }
        samples.drain(..weg_frames * kanaele_n);
        let weg = (weg_frames * kanaele_n) as u64;
        self.dropped += weg;
        self.nachzuegler.verworfen += weg;
        if samples.is_empty() {
            return None;
        }
        Some(rtp_roh.wrapping_add(frames_in_takte(weg_frames, rate) as u32))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 10 ms Opus in 48-k-Takten.
    const PAKET: i64 = 480;

    /// Ein Paket ganz vor der Position fällt ganz weg, die Grenze bleibt
    /// stehen; das nächste, das sie überdeckt, verliert nur den Anfang, und
    /// danach ist der Unterlauf abgearbeitet.
    #[test]
    fn ganz_davor_ganz_weg_teilweise_nur_der_anfang() {
        let mut n = Nachzuegler::default();
        // Position 25 ms hinter dem Paketstart.
        assert_eq!(n.pruefen(0, PAKET, 1200.0, true), PAKET);
        assert_eq!(n.pruefen(PAKET, PAKET, 1200.0, true), PAKET);
        assert_eq!(n.pruefen(2 * PAKET, PAKET, 1200.0, true), 240, "5 ms des dritten");
        // Abgearbeitet: das nächste bleibt, auch bei leerem Ring.
        assert_eq!(n.pruefen(3 * PAKET, PAKET, 9999.0, false), 0);
    }

    /// Ohne leeren Ring im Anlauf wird nicht geprüft — die Position stimmt
    /// beim Vorfüllen mit Vorrat nicht (Modulkopf).
    #[test]
    fn ohne_unterlauf_wird_nichts_verworfen() {
        let mut n = Nachzuegler::default();
        assert_eq!(n.pruefen(0, PAKET, 5000.0, false), 0);
        assert!(n.grenze.is_none());
    }

    /// Ein Paket, das VOR der Position liegt (Sender-Pause), und eines knapp
    /// hinter ihr (Rundung des Umrechners) bleiben ganz.
    #[test]
    fn sender_pause_und_rundung_bleiben() {
        let mut n = Nachzuegler::default();
        assert_eq!(n.pruefen(10_000, PAKET, 1200.0, true), 0, "Sender-Pause");
        assert_eq!(n.pruefen(1200, PAKET, 1200.0 + 50.0, true), 0, "unter der Toleranz");
        assert!(n.grenze.is_none());
    }

    /// Die Grenze steht fest: bei dauerhaft 40 ms Verspätung (Latenzsprung)
    /// werden genau vier Pakete verworfen, dann ist Schluss — mit der
    /// mitlaufenden Position würde jedes Paket verworfen.
    #[test]
    fn ein_latenzsprung_kostet_einmal_und_nicht_fuer_immer() {
        let mut n = Nachzuegler::default();
        let mut verworfen = 0;
        // Der Ring bleibt leer, bis zum ersten Mal etwas behalten wird.
        let mut ring_leer = true;
        for k in 0..20 {
            let start = k * PAKET;
            // Jedes Paket 40 ms (1920 Takte) hinter der mitlaufenden Position.
            let weg = n.pruefen(start, PAKET, (start + 1920) as f64, ring_leer);
            ring_leer &= weg == PAKET;
            verworfen += weg;
        }
        assert_eq!(verworfen, 1920);
        assert!(!ring_leer, "danach wird wieder angehängt");
    }

    /// Ein Rücksprung der Marken um mehr als die Höchstverspätung ist kein
    /// Nachzügler — weder beim Start des Unterlaufs noch mittendrin.
    #[test]
    fn ein_bruch_der_zeitbasis_ist_kein_nachzuegler() {
        let mut n = Nachzuegler::default();
        assert_eq!(n.pruefen(-48_000 * 3600, PAKET, 1200.0, true), 0);
        assert!(n.grenze.is_none());
        assert_eq!(n.pruefen(0, PAKET, 1200.0, true), PAKET);
        assert_eq!(n.pruefen(-48_000 * 3600, PAKET, 1200.0, true), 0, "mittendrin");
        assert!(n.grenze.is_none(), "und der Unterlauf ist damit beendet");
    }

    /// Der Nachlauf senkt die Kappschwelle auf Sollwert plus 30 ms — nur in
    /// seinem Fenster und nie über die normale.
    #[test]
    fn der_nachlauf_senkt_die_kappschwelle_auf_zeit() {
        let per_ms = 96;
        let soll = 60 * per_ms;
        let normal = 180 * per_ms;
        let jetzt = Instant::now();
        let mut n = Nachzuegler::default();
        assert_eq!(n.kappschwelle(normal, soll, per_ms, jetzt), normal, "ohne Anlauf");
        n.im_anlauf(jetzt);
        assert_eq!(n.kappschwelle(normal, soll, per_ms, jetzt), 90 * per_ms);
        assert_eq!(n.kappschwelle(70 * per_ms, soll, per_ms, jetzt), 70 * per_ms, "nie höher");
        assert_eq!(n.kappschwelle(normal, soll, per_ms, jetzt + NACHLAUF), normal, "abgelaufen");
    }

    /// Die Umrechnung trifft ganze Frames auch bei 44,1 kHz: 10 ms sind
    /// 441 Frames und zurück wieder 480 Takte.
    #[test]
    fn umrechnung_gegen_den_geraetetakt() {
        assert_eq!(frames_in_takte(441, 44_100), PAKET);
        assert_eq!(takte_in_frames(PAKET, 44_100), 441);
        assert_eq!(takte_in_frames(240, 48_000), 240);
        assert_eq!(takte_in_frames(-5, 48_000), 0);
    }
}
