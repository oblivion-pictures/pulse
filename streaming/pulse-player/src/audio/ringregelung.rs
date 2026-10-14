//! Rueckfuehrung des Ausgabe-Rings auf einen Sollfuellstand.
//!
//! **Ohne sie steigt der Fuellstand nur:** jede Lieferpause schiebt ihn hoch,
//! und nichts baut ihn wieder ab. Der harte Deckel in `audio.rs`
//! (`MAX_RING_SECONDS`) greift erst bei sechs Sekunden und ist damit keine
//! Regelung, sondern ein Notausgang.
//!
//! **Seit 2026-08-13 ist das hier nur noch der Notausgang.** Die laufende
//! Regelung macht [`super::uhrenabgleich`], indem er die Abspielrate nachfuehrt.
//! Was bleibt, ist der eine grobe Schnitt fuer Rueckstaende, die keine
//! Ratenkorrektur mehr einholt — ein Vielfaches des Sollwerts, wie es nach
//! einem Nachhol-Schwall entsteht.
//!
//! Eigenes Modul, damit `audio.rs` der Ausgabepfad bleibt: die Regelung ist ein
//! abgeschlossenes Stueck mit eigenen Messbegruendungen, und die Datei war mit
//! ihnen ueber die harte Groessen-Grenze von 500 Zeilen gewachsen
//! (`PLAN.md` §12.1).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Sollfuellstand des Rings in Millisekunden.
///
/// **Warum es den ueberhaupt braucht.** Bis 2026-08-05 gab es ihn nicht:
/// `target_fill` wurde ausschliesslich von `av_offset_ms` gesetzt, und dessen
/// Vorgabe ist 0. Die Anlaufsperre in `fill_output` griff damit nie, und es gab
/// weder Sollwert noch Rueckfuehrung — der Fuellstand war das freilaufende
/// Integral aller Liefer-Schwankungen: beim Verbinden zufaellig gesetzt, von
/// jedem Haenger einseitig nach oben geschoben, nie wieder abgebaut. Gemessen
/// am 2026-08-05: nach EINER Lieferpause blieb er bei 5980 ms stehen (dem
/// harten Deckel), mit 767 Unterlaeufen und 1,7 s verworfenem Ton — waehrend
/// das Bild wieder tadellos mit 60 fps lief. Sechs Sekunden Ton hinterher,
/// dauerhaft, ohne Erholung und ohne Meldung. Messakte
/// `profiles/ton-2026-08-05-windows-ringregelung.json`.
///
/// **Woher die 60 ms kommen** — aus Messwerten, nicht aus dem Gefuehl:
/// * In den gesunden Laeufen stellte sich der Ring von selbst auf 73-168 ms
///   ein. Das ist die Spanne, die die Strecke ohne Regelung erzeugt.
/// * Der Ankunftsabstand lag in der Produktion bei hoechstens 18-29 ms. Zwei
///   bis drei davon zu ueberbruecken sind rund 50-60 ms.
/// * Die Untergrenze setzt das Geraet: WASAPI-Shared ruft typisch alle 10 ms,
///   und in `fill_output` muss mindestens ein voller Aufruf Vorrat liegen,
///   sonst zaehlt jeder Jitter als Unterlauf.
///
/// **Getrennt von `av_offset_ms`, und das ist der Kern.** Jener ist der
/// Nutzer-Trim aus der Oberflaeche. Ihn als Sollwert zu missbrauchen hiess:
/// "Ton um 0 ms verschieben" bedeutet "gar kein Puffer" — genau der Fehler,
/// den es hier zu beheben gilt. Der Trim ist jetzt ein ZUSCHLAG hierauf.
pub(super) const RING_SOLL_MS: usize = 60;

/// Wie viele Millisekunden ueber dem Sollwert grob gekappt wird — gerechnet
/// auf den Sollwert OHNE Lippen-Eingriff (Grundwert plus Nutz-Trim,
/// `audio.rs`, `Shared::kapp_schwelle`).
///
/// Darunter regelt der Uhrenabgleich, ohne zu schneiden. Der Schnitt klingt wie
/// ein kurzer Aussetzer — verglichen mit sechs Sekunden bleibendem Versatz ist
/// das der bessere Tausch, aber er ist teuer genug, dass er nicht bei jedem
/// Jitter feuern darf.
///
/// **Bis zum 2026-10-14 ein Faktor** (das Dreifache des Sollwerts — beim
/// Grundwert dieselben 180 ms). Ein Faktor wanderte aber mit allem, was im
/// Sollwert steckt: mit dem Lippen-Eingriff (bei 40 ms Sollwert schon ab
/// 120 ms geschnitten) und mit dem Nutz-Trim (bei 500 ms Trim erst ab 1,68 s
/// Rueckstand, ab rund 1,9 s Trim nie, weil die Schwelle ueber der Ringgrenze
/// laege). Ein Rueckstand ist aber ein Zuviel an Zeit, unabhaengig davon, wie
/// viel Vorlauf jemand eingestellt hat.
pub(super) const RING_RUECKSTAND_MS: usize = 2 * RING_SOLL_MS;

/// Untergrenze des Ring-Sollwerts in Millisekunden, die auch der
/// Lippen-Eingriff nicht unterschreitet (`audio.rs`, `Shared::ziel_setzen`).
///
/// **Der Anlass** (Fernsteuerung, 2026-10-14): nach einer Serie von
/// Lieferaussetzern stand der Eingriff am Deckel (-150 ms), der Sollwert damit
/// bei 60 - 150 ms, also auf der damaligen Untergrenze von 1 ms. Der Ring hielt
/// 10-30 ms, und es folgten 60-150 Unterlaeufe je zehn Sekunden — jeder davon
/// Stille, die den Ton weiter hinter seine Uhr schob und den Regler noch tiefer
/// drueckte. Ein Kreis, der sich selbst naehrt.
///
/// Weniger Puffer kann den Ton nicht frueher machen, als seine Pakete
/// ankommen: kommt das Netz spaeter, ist auch das Bild spaeter (der Bild-Takt
/// zeigt ein verspaetetes Bild sofort, `app::takt`). Unter rund drei Geraete-
/// Aufrufen (WASAPI-Shared alle 10 ms) und gut einem Paket (10-20 ms) Vorrat
/// wird dagegen jeder normale Jitter zum Unterlauf: drei Aufrufe (30 ms) plus
/// ein Paket des eigenen Sendewegs (10 ms unter Windows und Linux; macOS
/// sendet 20 ms, dort bleibt entsprechend weniger Reserve) sind 40 ms. Gerechnet, nicht
/// gemessen — wer ihn aendert, misst nach. (Der Grundwert `RING_SOLL_MS` liegt
/// mit seinen gemessenen 2-3 Ankunftsabstaenden darueber; die Untergrenze ist
/// das, worunter auch ein Regler ihn nicht druecken darf.)
pub(super) const RING_BODEN_MS: usize = 40;

/// Wie lange der Ring ueber der Kappschwelle keinen neuen Hoechststand
/// erreicht haben muss, bevor geschnitten wird — „der Nachhol-Schwall ist
/// vorbei".
///
/// **Warum eine Zeit und nicht der Vergleich mit dem vorigen Paket** (so stand
/// es vom 2026-08-22 bis 2026-10-14): ein Schwall kommt nicht in einem Zug in
/// den Ring. Zwischen zwei seiner Pakete holt das Geraet seinen naechsten
/// Block ab, der Ring ist dann kurz KLEINER als beim Paket davor — und der
/// Vergleich hielt den Schwall fuer vorbei. Es wurde mitten im Schwall
/// geschnitten, die damalige Sperrfrist von fuenf Sekunden begann, und der
/// Rest des Schwalls blieb liegen. Gemessen am 2026-10-14 (Fernsteuerung,
/// Windows-Sender): nach jedem Aussetzer fuenf bis sechs Sekunden lang
/// 0,5-0,7 s Ton hinter dem Bild, dann ein zweiter hoerbarer Schnitt.
///
/// Angenommen, nicht gemessen: ein Schwall laeuft in wenigen Millisekunden in
/// den Ring (die Pakete kommen gesammelt, `audio.rs` dekodiert sie
/// hintereinander weg), 60 ms ohne neuen Hoechststand heisst dann, er ist
/// vorbei. Kommt er doch in Stuecken mit groesseren Abstaenden, wird zweimal
/// geschnitten — hoerbar, aber ohne bleibenden Versatz. Der Ton haengt
/// hoechstens diese 60 ms laenger nach als noetig.
const SCHWALL_RUHE: Duration = Duration::from_millis(60);

/// Wie viel ueber dem bisherigen Hoechststand ein Fuellstand liegen muss, um
/// als neuer zu gelten — ein Achtel des Rueckstands bis zur Schwelle (15 ms).
/// Ohne Toleranz setzte jeder normale Ankunftsjitter die Ruhezeit zurueck; ein
/// Schwall aus 10-ms-Paketen uebertrifft sie mit jedem zweiten Paket.
const SCHWALL_TOLERANZ_TEILER: usize = 8;

/// Zustand der Regelung. Liegt in `Shared` und wird nur vom Fuetter-Thread
/// beschrieben.
#[derive(Default)]
pub(super) struct Ringregelung {
    /// Wie oft der Ring grob auf den Sollwert gekappt wurde.
    ///
    /// **Gehoert gemeldet, nicht verschwiegen.** Der Schnitt ist hoerbar, und
    /// ein Eingriff, den niemand sieht, ist genau die Sorte Fehler, die hier
    /// behoben wird: der alte 6-Sekunden-Deckel kappte auch, nur eben zu spaet
    /// und lautlos.
    pub(super) resyncs: u64,
    /// Hoechster Fuellstand, seit der Ring ueber der Kappschwelle steht, und
    /// wann er erreicht wurde — daran haengt, ob der Schwall vorbei ist
    /// ([`SCHWALL_RUHE`]). `None` = unter der Schwelle.
    hoch: Option<(usize, Instant)>,
}

/// Steht der Ring ueber der Kappschwelle, baut ihn also die Grobkappung ab?
/// Auch fuer den Lippen-Regler (`audio.rs`): einen solchen Rueckstand regelt
/// er nicht mit, sonst integriert er einen Zustand auf, der gleich
/// weggeschnitten wird.
pub(super) fn im_rueckstand(fuellstand: usize, schwelle: usize) -> bool {
    schwelle > 0 && fuellstand > schwelle
}

impl Ringregelung {
    /// Nach dem Anhaengen frischer Samples anwenden. Gibt zurueck, wie viele
    /// Samples dabei verworfen wurden (fuer den `dropped`-Zaehler).
    ///
    /// Der Schnitt geht auf den Sollwert und trifft damit von selbst eine
    /// Frame-Grenze, solange der Sollwert eine ist (`RING_SOLL_MS * per_ms`).
    /// Die Kanalzahl braucht es hier deshalb nicht mehr — sie war nur fuer den
    /// entfernten Feinabbau noetig, der einzelne Samples anfasste und dabei bis
    /// 2026-08-08 die Kanalzuordnung kippen konnte.
    ///
    /// `soll` = wohin geschnitten wird (der wirksame Sollwert), `schwelle` =
    /// ab wann ([`RING_RUECKSTAND_MS`]). `jetzt` = Zeitpunkt des Anhaengens —
    /// fuer die Ruhezeit nach dem Schwall ([`SCHWALL_RUHE`]); hereingereicht
    /// statt selbst gelesen, damit die Tests einen Schwall in Mikrosekunden
    /// nachstellen koennen.
    pub(super) fn nach_anhaengen(
        &mut self,
        ring: &mut VecDeque<f32>,
        soll: usize,
        schwelle: usize,
        jetzt: Instant,
    ) -> u64 {
        if soll == 0 || !im_rueckstand(ring.len(), schwelle) {
            self.hoch = None;
            return 0;
        }
        // **Erst schneiden, wenn der Schwall vorbei ist** — und das heisst:
        // seit [`SCHWALL_RUHE`] kein neuer Hoechststand. Auf einem
        // Augenblickswert zu entscheiden, waehrend sich der Wert noch bewegt,
        // war zweimal der Fehler hier (2026-08-22 ein Schnitt bei der ersten
        // Ueberschreitung, 2026-10-14 einer zwischen zwei Paketen des
        // Schwalls; Begruendung an `SCHWALL_RUHE`).
        let toleranz = schwelle.saturating_sub(soll) / SCHWALL_TOLERANZ_TEILER;
        let seit = match self.hoch {
            Some((hoch, seit)) if ring.len() <= hoch + toleranz => seit,
            _ => {
                self.hoch = Some((ring.len(), jetzt));
                jetzt
            }
        };
        if jetzt.saturating_duration_since(seit) < SCHWALL_RUHE {
            return 0;
        }
        // Grob: nach einem Nachhol-Schwall in EINEM Schnitt zurueck auf den
        // Sollwert. Hoerbar wie ein kurzer Aussetzer — und der bessere Tausch
        // gegen einen Rueckstand, der sonst bis Sitzungsende bleibt.
        //
        // **Ohne Sperrfrist danach** (bis 2026-10-14: fuenf Sekunden). Sie
        // sollte mehrere Schnitte bei mehreren Lieferpausen kurz hintereinander
        // verhindern — aber jede dieser Pausen hinterlaesst ihren eigenen
        // Rueckstand, und ihn fuenf Sekunden liegen zu lassen heisst, den Ton
        // fuenf Sekunden lang um eine halbe Sekunde hinter dem Bild laufen zu
        // lassen. Dass ein Schwall nur EINEN Schnitt bekommt, sichert jetzt
        // die Ruhezeit.
        // Abgesichert, obwohl `audio.rs::kapp_schwelle` die Schwelle ueber dem
        // Sollwert haelt: ein Unterlauf hier risse den Ton-Faden mit.
        let Some(excess) = ring.len().checked_sub(soll) else { return 0 };
        ring.drain(..excess);
        self.resyncs += 1;
        self.hoch = None;
        excess as u64
        // **Hier stand bis zum 2026-08-13 ein Feinabbau, und er war die Ursache
        // des Fehlers, den er verhindern sollte.** Ein Frame je 2000 angehaengter
        // Samples, gemessen am Fuellstand unmittelbar NACH dem Anhaengen — also
        // im Hochpunkt der Saegezahnkurve. Der Ring pendelte damit um die halbe
        // Paketgroesse unter den Sollwert, die Sicherheitsreserve war
        // aufgezehrt, ein normaler Ankunftsjitter reichte zum Leerlaufen, und
        // der Unterlauf schob den Fuellstand schlagartig wieder hoch. In einem
        // Lauf von 307 s: rund 0,8 s Stille in etwa zwoelf Stuecken und 70 390
        // verworfene Samples — kein Ueberlauf, sondern ein Regelkreis gegen sich
        // selbst (Messakte in den Protokollen vom 2026-08-13).
        //
        // Ersetzt durch [`super::uhrenabgleich`]: der fuehrt die Abspielrate um
        // Bruchteile eines Promille nach, statt Ton zu schneiden — stetig,
        // unhoerbar, und erstmals auch in der Gegenrichtung.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verschraenktes Stereo, an dem sich die Kanaele unterscheiden lassen:
    /// links immer `+1.0`, rechts immer `-1.0`. Index 0 ist eine Kanalgrenze.
    fn stereo_ring(laenge: usize) -> VecDeque<f32> {
        (0..laenge).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect()
    }

    /// **Die beiden Reproduktionen zu Befund 10 sind hier entfallen**, und zwar
    /// gegenstandslos geworden statt stillgelegt: sie belegten, dass der
    /// Feinabbau einzelne Samples entfernte und dabei die Kanalzuordnung
    /// kippte. Den Feinabbau gibt es seit dem 2026-08-13 nicht mehr — die
    /// laufende Regelung macht `super::uhrenabgleich`, ohne den Ring
    /// anzufassen. Ein Test auf einen entfernten Zweig haette nur noch
    /// bewiesen, dass er entfernt ist.
    ///
    /// Was bleibt, ist der Grobschnitt, und der wird hier geprueft.

    const SOLL: usize = RING_SOLL_MS * 96;
    const SCHWELLE: usize = (RING_SOLL_MS + RING_RUECKSTAND_MS) * 96;

    /// Ueber dem Vielfachen des Sollwerts wird in EINEM Schnitt zurueckgesetzt —
    /// sobald der Ring [`SCHWALL_RUHE`] lang keinen neuen Hoechststand hatte.
    #[test]
    fn ueber_der_kappschwelle_geht_es_zurueck_auf_den_sollwert() {
        let t0 = Instant::now();
        let mut ring = stereo_ring(SCHWELLE + 100);
        let mut r = Ringregelung::default();

        assert_eq!(r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0), 0, "erst warten, ob noch mehr kommt");
        let verworfen = r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0 + SCHWALL_RUHE);

        assert_eq!(ring.len(), SOLL);
        assert_eq!(verworfen, (SCHWELLE + 100 - SOLL) as u64);
        assert_eq!(r.resyncs, 1);
    }

    /// Der Schnitt trifft eine Kanalgrenze, solange der Sollwert eine ist —
    /// sonst waeren nach dem Schnitt links und rechts vertauscht.
    #[test]
    fn der_grobschnitt_laesst_die_kanalzuordnung_stehen() {
        let t0 = Instant::now();
        let mut ring = stereo_ring(SCHWELLE + 100);
        let mut r = Ringregelung::default();
        assert_eq!(ring[0], 1.0, "Vorbedingung: der Ring beginnt auf dem linken Kanal");

        r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0);
        r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0 + SCHWALL_RUHE);

        assert_eq!(r.resyncs, 1, "Vorbedingung: es wurde geschnitten");
        assert_eq!(ring[0], 1.0, "nach dem Schnitt muss der Ring links beginnen");
    }

    /// Unterhalb der Kappschwelle wird **nichts** angefasst — dort regelt der
    /// Uhrenabgleich (2026-08-13: hier lag der Feinabbau, der die
    /// Sicherheitsreserve aufzehrte).
    #[test]
    fn unter_der_kappschwelle_bleibt_der_ring_unberuehrt() {
        let t0 = Instant::now();
        let laenge = SOLL * 2;
        let mut ring = stereo_ring(laenge);
        let mut r = Ringregelung::default();

        for i in 0..10 {
            assert_eq!(r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0 + SCHWALL_RUHE * i), 0);
        }
        assert_eq!(ring.len(), laenge, "und der Ring bleibt unveraendert lang");
        assert_eq!(r.resyncs, 0);
    }

    /// **Der Fall vom 2026-10-14.** Der Schwall kommt in Stuecken, und
    /// zwischen zweien holt das Geraet einen Block ab — der Ring ist dann kurz
    /// kleiner als beim Paket davor. Der alte Vergleich mit dem vorigen Paket
    /// hielt das fuer das Ende des Schwalls und schnitt mittendrin; der Rest
    /// blieb danach fuenf Sekunden liegen (Sperrfrist). Jetzt wird erst
    /// geschnitten, wenn der Schwall wirklich vorbei ist — EINMAL, und der
    /// ganze Rueckstand ist weg.
    #[test]
    fn zwischen_den_paketen_des_schwalls_wird_nicht_geschnitten() {
        let t0 = Instant::now();
        let paket = 10 * 96; // 10 ms Stereo
        let mut ring = stereo_ring(SOLL);
        let mut r = Ringregelung::default();

        // 64 Pakete in 6 ms, nach jedem vierten holt das Geraet 10 ms ab.
        for i in 0..64u32 {
            ring.extend(stereo_ring(paket));
            if i % 4 == 3 {
                ring.drain(..paket);
            }
            let jetzt = t0 + Duration::from_micros(u64::from(i) * 100);
            assert_eq!(r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, jetzt), 0, "Paket {i}: mitten im Schwall");
        }
        let hoehepunkt = ring.len();
        assert!(im_rueckstand(hoehepunkt, SCHWELLE), "Vorbedingung: weit ueber der Schwelle");

        // Danach der Regelbetrieb: je Paket rein, je Aufruf raus.
        let mut verworfen = 0;
        for k in 1..=10u32 {
            ring.extend(stereo_ring(paket));
            ring.drain(..paket);
            verworfen += r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0 + Duration::from_millis(6 + 10 * u64::from(k)));
        }
        assert_eq!(r.resyncs, 1, "genau EIN Schnitt, nach dem Schwall");
        assert_eq!(verworfen, (hoehepunkt - SOLL) as u64, "und er raeumt den ganzen Rueckstand");
    }

    /// Ein Schwall, der LAENGER als die Ruhezeit waechst, wird nicht
    /// angeschnitten: gemessen wird ab dem letzten Hoechststand, nicht ab dem
    /// ersten Ueberschreiten der Schwelle.
    #[test]
    fn ein_langer_schwall_wird_erst_an_seinem_ende_geschnitten() {
        let t0 = Instant::now();
        let mut ring = stereo_ring(SCHWELLE + 100);
        let mut r = Ringregelung::default();
        // 300 ms lang alle 20 ms ein Stueck von 20 ms obendrauf.
        for k in 0..=15u64 {
            let jetzt = t0 + Duration::from_millis(20 * k);
            assert_eq!(r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, jetzt), 0, "nach {} ms", 20 * k);
            ring.extend(stereo_ring(20 * 96));
        }
        let ende = t0 + Duration::from_millis(320);
        r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, ende);
        assert_eq!(r.resyncs, 0, "der letzte Hoechststand ist frisch");
        r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, ende + SCHWALL_RUHE);
        assert_eq!(r.resyncs, 1);
        assert_eq!(ring.len(), SOLL);
    }

    /// Ankunftsjitter unterhalb der Toleranz setzt die Ruhezeit nicht zurueck —
    /// sonst wuerde ein Rueckstand im Regelbetrieb nie geschnitten.
    #[test]
    fn jitter_unter_der_toleranz_haelt_die_ruhezeit_nicht_auf() {
        let t0 = Instant::now();
        let mut ring = stereo_ring(SCHWELLE + 100);
        let mut r = Ringregelung::default();
        r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0);
        // 5 ms ueber dem Hoechststand — unter den 15 ms Toleranz.
        ring.extend(stereo_ring(5 * 96));
        r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0 + Duration::from_millis(30));
        r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, t0 + SCHWALL_RUHE);
        assert_eq!(r.resyncs, 1, "die Ruhezeit lief ab dem ersten Hoechststand");
    }

    /// Zwei Aussetzer kurz hintereinander bekommen zwei Schnitte — jeder hat
    /// seinen eigenen Rueckstand, und den liegen zu lassen hiesse, den Ton
    /// hinter dem Bild laufen zu lassen (bis 2026-10-14: fuenf Sekunden
    /// Sperrfrist).
    #[test]
    fn ein_zweiter_schwall_bekommt_seinen_eigenen_schnitt() {
        let t0 = Instant::now();
        let mut r = Ringregelung::default();
        for start in [t0, t0 + Duration::from_secs(1)] {
            let mut ring = stereo_ring(SCHWELLE + 100);
            r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, start);
            r.nach_anhaengen(&mut ring, SOLL, SCHWELLE, start + SCHWALL_RUHE);
            assert_eq!(ring.len(), SOLL);
        }
        assert_eq!(r.resyncs, 2);
    }

    /// Ohne Sollwert (Geraet noch nicht bekannt) passiert gar nichts.
    #[test]
    fn ohne_sollwert_passiert_nichts() {
        let mut ring = stereo_ring(10_000);
        let mut r = Ringregelung::default();
        assert_eq!(r.nach_anhaengen(&mut ring, 0, 0, Instant::now()), 0);
        assert_eq!(ring.len(), 10_000);
    }
}
