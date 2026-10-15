//! Tests der Tonausgabe — aus `audio.rs` herausgeloest (Groessengrenze,
//! `PLAN.md` §12.1) am 2026-10-14, im selben Zug angepasst (Schwall-Erkennung,
//! Lippen-Regler ohne Ringabweichung).

use super::*;
// Nur die Tests brauchen FFmpeg noch unmittelbar (echte Opus-Dateien); der
// Ausgabepfad selbst kommt seit der Auslagerung des Decoders ohne aus.
use ffmpeg_next as ffmpeg;

/// Ein frisches `Shared` mit dem gewuenschten Zielfuellstand, Ring leer.
pub(super) fn shared_mit(target_fill: usize) -> Mutex<Shared> {
    Mutex::new(Shared {
        ring: VecDeque::new(),
        volume: 1.0,
        target_fill,
        underruns: 0,
        dropped: 0,
        nachzuegler: Default::default(),
        regelung: Ringregelung::default(),
        abgleich: Uhrenabgleich::default(),
        anlauf: true,
        alive: true,
        geraetefehler: false,
        ausgabe: 0,
        tonuhr: None,
        trim_ms: 0,
        sync_ms: 0.0,
        letzte_fehler_ms: 0.0,
        letzte_nachfuehr: None,
        per_ms: TEST_PER_MS,
        max_ziel: TEST_MAX_RING / 2,
        verdeckung: Default::default(),
    })
}

/// Ein `Shared` wie zur Laufzeit: Sollwert gesetzt, Ring leer.
fn shared_mit_soll(per_ms: usize) -> Mutex<Shared> {
    shared_mit(RING_SOLL_MS * per_ms)
}

/// 48 kHz stereo — dieselbe Rechnung wie zur Laufzeit.
const TEST_PER_MS: usize = 96;
const TEST_MAX_RING: usize = MAX_RING_SECONDS * 48_000 * 2;

/// **Der Fehler vom 2026-08-07.** Die Anlaufsperre war als Startbedingung
/// gemeint, wirkte aber bei jedem Geraete-Aufruf: ein Ring unter dem
/// Sollwert hiess Stille, bis die vollen 60 ms wieder beisammen waren. Aus
/// einer Delle wurde damit ein Aussetzer von rund sechs Aufrufen — und
/// gezaehlt wurde er nirgends.
#[test]
fn eine_delle_unter_dem_sollwert_haelt_die_ausgabe_nicht_an() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let soll = RING_SOLL_MS * TEST_PER_MS;
    shared.lock().unwrap().ring.extend(vec![0.5f32; soll]);

    // Anlauf: mit vollem Sollwert geht die Ausgabe los.
    let mut out = vec![0.0f32; 32];
    fill_output(&shared, &mut out);
    assert!(out.iter().all(|v| *v == 0.5), "nach dem Anlauf muss Ton kommen");

    // Unter den Sollwert fallen lassen, ohne leerzulaufen.
    {
        let mut s = shared.lock().unwrap();
        s.ring.clear();
        s.ring.extend(vec![0.25f32; 64]);
        s.underruns = 0;
    }
    let mut out = vec![0.0f32; 32];
    fill_output(&shared, &mut out);
    assert!(
        out.iter().all(|v| *v == 0.25),
        "eine Delle unter dem Sollwert darf die Ausgabe nicht anhalten"
    );
    assert_eq!(shared.lock().unwrap().underruns, 0, "und ist kein Unterlauf");
}

/// Die Gegenprobe: laeuft der Ring wirklich leer, wird wieder vorgefuellt —
/// und JEDE dabei ausgegebene Stille zaehlt als Unterlauf. Ohne das misst
/// die Kennzahl den haeufigsten Fall nicht mit.
#[test]
fn ein_leergelaufener_ring_fuellt_wieder_vor_und_zaehlt_die_stille() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let soll = RING_SOLL_MS * TEST_PER_MS;
    shared.lock().unwrap().ring.extend(vec![0.5f32; soll]);

    // Mehr verlangt, als da ist: der Ring laeuft mitten im Aufruf leer.
    let mut out = vec![0.0f32; soll + 16];
    fill_output(&shared, &mut out);
    {
        let s = shared.lock().unwrap();
        assert_eq!(s.underruns, 1, "der Unterlauf gehoert gezaehlt");
        assert!(s.anlauf, "nach dem Leerlaufen wird wieder vorgefuellt");
    }

    // Zu wenig Nachschub: es bleibt still, und die Stille wird gezaehlt.
    shared.lock().unwrap().ring.extend(vec![0.5f32; 32]);
    let mut out = vec![0.0f32; 32];
    fill_output(&shared, &mut out);
    assert!(out.iter().all(|v| *v == 0.0), "unter dem Sollwert bleibt es beim Vorfuellen");
    assert_eq!(shared.lock().unwrap().underruns, 2);
}

/// Befehle aus einem eigenen Faden schicken — mit echten Pausen
/// dazwischen, weil die Grobkappung erst nach einer Ruhezeit schneidet
/// (`ringregelung::SCHWALL_RUHE`) und `pump_commands` die Uhr selbst liest.
fn mit_pausen(shared: &Arc<Mutex<Shared>>, schritte: Vec<(u64, AudioCommand)>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let sender = std::thread::spawn(move || {
        for (pause_ms, cmd) in schritte {
            std::thread::sleep(std::time::Duration::from_millis(pause_ms));
            tx.send(cmd).unwrap();
        }
        tx.send(AudioCommand::Stop).unwrap();
    });
    pump_commands(&rx, shared, TEST_PER_MS, TEST_MAX_RING, 48_000, 2);
    sender.join().unwrap();
}

/// **Der Fall, um den es geht.** Ein Nachhol-Schwall nach einer
/// Lieferpause schiebt den Ring weit ueber den Sollwert. Ohne Grobkappung
/// bliebe er dort bis Sitzungsende — am 2026-08-05 gemessen: 5980 ms, ueber
/// 30 s hinweg, ohne Erholung und ohne Meldung. Geschnitten wird, sobald
/// der Schwall vorbei ist: das naechste Paket nach der Ruhezeit.
///
/// Als Test und nicht als Lastlauf, weil ein Lastlauf den Fall nur
/// zufaellig trifft: der Versuch, ihn ueber CPU-Last zu erzwingen, blieb
/// am 2026-08-05 folgenlos (Ring 87-118 ms, keine Kappung).
#[test]
fn grobkappung_holt_den_ring_zurueck() {
    let shared = Arc::new(shared_mit_soll(TEST_PER_MS));
    let soll = RING_SOLL_MS * TEST_PER_MS;
    // Vier Sollwerte auf einmal — ueber der Kappschwelle (Faktor 3).
    mit_pausen(
        &shared,
        vec![
            (0, AudioCommand::Pcm(vec![0.0; soll * 4], None)),
            (100, AudioCommand::Pcm(Vec::new(), None)),
        ],
    );
    let s = shared.lock().unwrap();
    assert_eq!(s.ring.len(), soll, "Ring muss auf den Sollwert zurueck");
    assert_eq!(s.regelung.resyncs, 1, "die Kappung gehoert gezaehlt — sie ist hoerbar");
}

/// Nach einem Schnitt beginnt der Uhrenabgleich frisch — sein Mittel
/// truege sonst den weggeschnittenen Rueckstand weiter.
#[test]
fn nach_einem_schnitt_beginnt_der_uhrenabgleich_frisch() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let mut s = shared.lock().unwrap();
    let schwelle = s.kapp_schwelle();
    let soll = s.target_fill;
    s.abgleich.beobachten(schwelle + 100, soll, 960, TEST_PER_MS, 2);
    assert!(s.abgleich.mittel().is_some(), "Vorbedingung: es gibt ein Mittel");
    s.ring.extend(vec![0.0f32; schwelle + 100]);
    s.zurueckfuehren();
    assert_eq!(s.regelung.resyncs, 0, "erst die Ruhezeit");
    std::thread::sleep(std::time::Duration::from_millis(80));
    s.zurueckfuehren();
    assert_eq!(s.regelung.resyncs, 1);
    assert!(s.abgleich.mittel().is_none(), "das alte Mittel ist verworfen");
}

/// Ein positiver Eingriff hebt den Sollwert ueber den Grundwert — die
/// Kappschwelle muss mitkommen, sonst stuende der Ring im Regelbetrieb
/// „im Rueckstand" und ein Schnitt koennte unter den Sollwert unterlaufen.
#[test]
fn die_kappschwelle_bleibt_ueber_dem_sollwert() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let mut s = shared.lock().unwrap();
    s.sync_ms = 150.0;
    s.ziel_setzen();
    let schwelle = s.kapp_schwelle();
    assert!(schwelle > s.target_fill, "Schwelle {schwelle} unter Sollwert {}", s.target_fill);
    // Ein Ring knapp ueber dem Grundwert-Schwellwert, aber unter dem
    // Sollwert: weder Rueckstand noch Schnitt.
    let fuellstand = (RING_SOLL_MS + RING_RUECKSTAND_MS + 10) * TEST_PER_MS;
    assert!(fuellstand < s.target_fill + RING_RUECKSTAND_MS * TEST_PER_MS);
    s.ring.extend(vec![0.0f32; fuellstand]);
    s.zurueckfuehren();
    std::thread::sleep(std::time::Duration::from_millis(80));
    s.zurueckfuehren();
    assert_eq!(s.regelung.resyncs, 0);
    assert_eq!(s.ring.len(), fuellstand);
}

/// Der Lippen-Eingriff unterschreitet die Untergrenze des Rings nicht —
/// und bleibt selbst auf ihr stehen, statt weiter bis an seinen Deckel zu
/// laufen (2026-10-14: Deckel -150 ms, Sollwert 1 ms, Unterlauf-Serie).
#[test]
fn der_eingriff_haelt_den_ring_ueber_der_untergrenze() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let mut s = shared.lock().unwrap();
    s.sync_ms = -150.0;
    s.ziel_setzen();
    assert_eq!(s.target_fill, RING_BODEN_MS * TEST_PER_MS);
    assert_eq!(s.sync_ms, RING_BODEN_MS as f32 - RING_SOLL_MS as f32, "Eingriff auf den Boden zurueckgenommen");
    // Mit Nutz-Trim ist mehr Eingriff moeglich, die Untergrenze bleibt dieselbe.
    s.trim_ms = 40;
    s.sync_ms = -150.0;
    s.ziel_setzen();
    assert_eq!(s.target_fill, RING_BODEN_MS * TEST_PER_MS);
}

/// Ein Nachhol-Rueckstand im Ring wird nicht in den Lippen-Eingriff
/// integriert — den baut die Grobkappung ab. Ohne das stand der Eingriff
/// am 2026-10-14 nach drei Aussetzern am Deckel.
///
/// Prueft die VERDRAHTUNG in der Fuetterschleife: bei Rueckstand bleibt der
/// Eingriff exakt stehen. Ohne Geraet laeuft der Ausgabezaehler nicht, der
/// Fehler ist hier deshalb klein — die Regel selbst (wann nicht nachgefuehrt
/// wird) prueft `lippen::tests::wann_nicht_nachgefuehrt_wird`. Der Anlauf ist
/// aus, damit allein der Rueckstand den Eingriff anhaelt.
#[test]
fn ein_rueckstand_wird_nicht_in_den_eingriff_integriert() {
    let shared = Arc::new(shared_mit_soll(TEST_PER_MS));
    shared.lock().unwrap().anlauf = false;
    let soll = RING_SOLL_MS * TEST_PER_MS;
    mit_pausen(
        &shared,
        vec![
            (0, AudioCommand::Pcm(vec![0.0; soll], Some(0))),
            // 20 ms spaeter der Schwall: fuenffacher Sollwert im Ring.
            (20, AudioCommand::Pcm(vec![0.0; soll * 4], Some(960))),
        ],
    );
    let s = shared.lock().unwrap();
    assert!(im_rueckstand(s.ring.len(), s.kapp_schwelle()), "Vorbedingung: der Rueckstand steht noch");
    assert_eq!(s.sync_ms, 0.0, "der Rueckstand darf den Eingriff nicht bewegen");
}

/// Unter dem Sollwert wird NICHT abgebaut — sonst arbeitete die Regelung
/// gegen den normalen Jitter und erzeugte die Unterlaeufe, die sie
/// verhindern soll.
#[test]
fn unter_dem_sollwert_bleibt_alles_liegen() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let soll = RING_SOLL_MS * TEST_PER_MS;
    let (tx, rx) = std::sync::mpsc::channel();
    tx.send(AudioCommand::Pcm(vec![0.0; soll / 2], None)).unwrap();
    tx.send(AudioCommand::Stop).unwrap();
    pump_commands(&rx, &shared, TEST_PER_MS, TEST_MAX_RING, 48_000, 2);
    let s = shared.lock().unwrap();
    assert_eq!(s.ring.len(), soll / 2, "nichts darf verworfen werden");
    assert_eq!(s.dropped, 0);
    assert_eq!(s.regelung.resyncs, 0);
}

/// Der Nutzer-Trim ist ein ZUSCHLAG auf den Sollwert, kein Ersatz. Bis
/// 2026-08-05 hiess `av_offset_ms = 0` "gar kein Puffer" — der Kern des
/// Fehlers.
#[test]
fn trim_addiert_sich_auf_den_sollwert() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let (tx, rx) = std::sync::mpsc::channel();
    tx.send(AudioCommand::OffsetMs(40)).unwrap();
    tx.send(AudioCommand::Stop).unwrap();
    pump_commands(&rx, &shared, TEST_PER_MS, TEST_MAX_RING, 48_000, 2);
    let s = shared.lock().unwrap();
    assert_eq!(
        s.target_fill,
        (RING_SOLL_MS + 40) * TEST_PER_MS,
        "Trim muss auf den Sollwert addieren"
    );
}

// --- Verspaeteter Ton nach einem Unterlauf (s. `nachzuegler`) -------------
//
// Die Tests treiben Fuetterschleife und Geraete-Rueckruf von Hand im Wechsel:
// ein Paket = 10 ms Opus = 480 RTP-Takte = 960 verschraenkte Samples, ein
// Geraete-Aufruf ebenfalls 10 ms. So stehen Ausgabezaehler und Marken genau
// in dem Verhaeltnis, das die Tonuhr zur Laufzeit sieht.

const PAKET_TAKTE: u32 = 480;
const PAKET_SAMPLES: usize = 10 * TEST_PER_MS;

/// Pakete mit den Marken `marken` in einem Zug durch die Fuetterschleife.
fn fuettern(shared: &Mutex<Shared>, marken: impl IntoIterator<Item = u32>) {
    let (tx, rx) = std::sync::mpsc::channel();
    for marke in marken {
        tx.send(AudioCommand::Pcm(vec![0.1; PAKET_SAMPLES], Some(marke))).unwrap();
    }
    tx.send(AudioCommand::Stop).unwrap();
    pump_commands(&rx, shared, TEST_PER_MS, TEST_MAX_RING, 48_000, 2);
}

/// Ein Geraete-Aufruf ueber 10 ms.
fn geraet(shared: &Mutex<Shared>) {
    let mut out = vec![0.0f32; PAKET_SAMPLES];
    fill_output(shared, &mut out);
}

/// Gleichmaessiger Betrieb: je Runde ein Geraete-Aufruf und ein Paket, ab der
/// Marke `ab`. Gibt die naechste Marke zurueck.
fn gleichmaessig(shared: &Mutex<Shared>, ab: u32, runden: u32) -> u32 {
    for k in 0..runden {
        geraet(shared);
        fuettern(shared, [ab + k * PAKET_TAKTE]);
    }
    ab + runden * PAKET_TAKTE
}

/// Start: sechs Pakete (= Sollwert) vorfuellen, dann eine halbe Sekunde
/// gleichmaessig. Danach steht der Ring nach jedem Anhaengen auf dem Sollwert.
fn eingeschwungen(shared: &Mutex<Shared>) -> u32 {
    fuettern(shared, (0..6).map(|k| k * PAKET_TAKTE));
    gleichmaessig(shared, 6 * PAKET_TAKTE, 50)
}

/// **Der Befund vom 2026-10-14.** Nach einem Aussetzer laeuft der Ring leer,
/// das Geraet spielt 30 ms Stille, dann kommt alles Verpasste mit dem
/// Puenktlichen in einem Schwall. Angehaengt stand der Ring danach 30 ms ueber
/// dem Sollwert — und blieb dort, weil das unter der Kappschwelle liegt.
/// Verworfen wird genau, was fuer die Stille bestimmt war; der Ring steht
/// danach auf dem Sollwert, und der puenktliche Ton liegt wieder um den
/// Ringvorrat vor der Position — nichts weiter wird verworfen.
#[test]
fn verspaeteter_ton_nach_einem_unterlauf_wird_verworfen() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let soll = RING_SOLL_MS * TEST_PER_MS;
    let naechste = eingeschwungen(&shared);
    let vorher = shared.lock().unwrap().nachzuegler.verworfen;
    assert_eq!(vorher, 0, "Start und Betrieb verwerfen nichts");

    // 90 ms ohne Nachschub: 60 ms Vorrat, dann 30 ms Stille.
    for _ in 0..9 {
        geraet(&shared);
    }
    {
        let s = shared.lock().unwrap();
        assert!(s.anlauf && s.ring.is_empty(), "Vorbedingung: der Ring lief leer");
    }
    // Der Schwall: alles, was in den 90 ms haette kommen sollen.
    fuettern(&shared, (0..9).map(|k| naechste + k * PAKET_TAKTE));
    {
        let s = shared.lock().unwrap();
        assert_eq!(s.ring.len(), soll, "Sollwert statt Sollwert + 30 ms Stille");
        assert_eq!(s.nachzuegler.verworfen, 3 * PAKET_SAMPLES as u64, "genau die 30 ms Stille");
        assert_eq!(s.dropped, 3 * PAKET_SAMPLES as u64, "und in der Gesamtzahl");
    }

    // Weiter in Echtzeit: das Geraet laeuft an, und das naechste Paket liegt
    // um den Vorrat VOR dem Anhaengen vor der Position — Sollwert minus ein
    // Paket. Mit diesem Abstand kann es nicht als verspaetet gelten.
    geraet(&shared);
    let marke = naechste + 9 * PAKET_TAKTE;
    {
        let s = shared.lock().unwrap();
        assert!(!s.anlauf, "der Ring stand auf dem Sollwert, die Ausgabe laeuft");
        let uhr = s.tonuhr.as_ref().unwrap();
        let vorsprung = uhr.marke(marke) as f64 - uhr.position(s.ausgabe, 48_000, 2);
        let erwartet = ((soll - PAKET_SAMPLES) / 2) as f64;
        assert!((vorsprung - erwartet).abs() < 1.0, "Vorsprung {vorsprung} statt {erwartet} Takte");
    }
    fuettern(&shared, [marke]);
    let unterlaeufe = shared.lock().unwrap().underruns;
    gleichmaessig(&shared, marke + PAKET_TAKTE, 100);
    let s = shared.lock().unwrap();
    assert_eq!(s.nachzuegler.verworfen, 3 * PAKET_SAMPLES as u64, "danach nichts mehr");
    assert_eq!(s.ring.len(), soll);
    assert_eq!(s.underruns, unterlaeufe);
}

/// Pausiert der Sender, springen seine Marken nach vorn: das erste Paket nach
/// der Pause liegt VOR der Position. Nichts wird verworfen, und das Vorfuellen
/// laeuft wie gehabt bis zum Sollwert.
#[test]
fn nach_einer_sender_pause_wird_nichts_verworfen() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let soll = RING_SOLL_MS * TEST_PER_MS;
    let naechste = eingeschwungen(&shared);
    for _ in 0..9 {
        geraet(&shared);
    }
    // Der Sender schickte 90 ms lang nichts und macht mit seiner Jetzt-Marke
    // weiter, eins nach dem anderen.
    fuettern(&shared, [naechste + 9 * PAKET_TAKTE]);
    gleichmaessig(&shared, naechste + 10 * PAKET_TAKTE, 5);
    let s = shared.lock().unwrap();
    assert_eq!(s.nachzuegler.verworfen, 0);
    assert_eq!(s.regelung.resyncs, 0, "gleichmaessiger Nachschub kostet auch im Nachlauf nichts");
    assert_eq!(s.ring.len(), soll, "vorgefuellt bis zum Sollwert");
}

/// Beim Vorfuellen mit Vorrat wird nicht geprueft: da steht der Ring, die
/// Position der Tonuhr laeuft aber weiter — ein Paket, das nur 10 ms Jitter
/// hat, laege scheinbar hinter ihr. Verworfen werden darf das nicht; es klingt
/// ja noch gar nichts. Und das Vorfuellen erreicht den Sollwert.
#[test]
fn jitter_beim_vorfuellen_wird_nicht_verworfen() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let soll = RING_SOLL_MS * TEST_PER_MS;
    let naechste = eingeschwungen(&shared);
    for _ in 0..9 {
        geraet(&shared);
    }
    let erste = naechste + 9 * PAKET_TAKTE;
    fuettern(&shared, [erste]);
    // Das naechste Paket kommt erst nach ZWEI Geraete-Aufrufen.
    geraet(&shared);
    geraet(&shared);
    fuettern(&shared, [erste + PAKET_TAKTE]);
    gleichmaessig(&shared, erste + 2 * PAKET_TAKTE, 4);
    let s = shared.lock().unwrap();
    assert_eq!(s.nachzuegler.verworfen, 0);
    assert_eq!(s.ring.len(), soll);
}

/// Ein Latenzsprung: ab jetzt kommt jedes Paket 100 ms spaeter als vorher,
/// in Echtzeit. Mit der Position als mitlaufender Grenze laege JEDES Paket
/// 40 ms hinter ihr, der Ring bliebe leer — Stille ohne Ende. Die feste
/// Grenze verwirft einmal die 40 ms, dann fuellt der Ring vor und laeuft.
#[test]
fn ein_latenzsprung_endet_nicht_in_dauerstille() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let soll = RING_SOLL_MS * TEST_PER_MS;
    let naechste = eingeschwungen(&shared);
    // 100 ms ohne Paket (60 ms Vorrat, 40 ms Stille): neun Aufrufe hier, der
    // zehnte ist der erste in `gleichmaessig`.
    for _ in 0..9 {
        geraet(&shared);
    }
    // Dann wieder ein Paket je Aufruf, lueckenlos ab der verpassten Marke.
    gleichmaessig(&shared, naechste, 30);
    let s = shared.lock().unwrap();
    assert_eq!(s.nachzuegler.verworfen, 4 * PAKET_SAMPLES as u64, "einmal 40 ms, nicht mehr");
    assert!(!s.anlauf, "die Ausgabe laeuft wieder");
    assert_eq!(s.ring.len(), soll);
}

/// Sender und Netz nachgestellt: der Sender legt je Takt (10 ms) ein Paket an,
/// das Netz liefert je Takt `liefern` Pakete aus seiner Warteschlange, in
/// Reihenfolge. Damit laesst sich jedes Muster aus Aussetzern und Aufholen
/// beschreiben, ohne Marken von Hand zu rechnen.
#[derive(Default)]
struct Strecke {
    erzeugt: u32,
    geliefert: u32,
}

impl Strecke {
    /// Ein Takt: Geraete-Aufruf, ein neues Paket beim Sender, Lieferung.
    fn takt(&mut self, shared: &Mutex<Shared>, liefern: u32) {
        geraet(shared);
        self.erzeugt += 1;
        let n = liefern.min(self.erzeugt - self.geliefert);
        fuettern(shared, (self.geliefert..self.geliefert + n).map(|k| k * PAKET_TAKTE));
        self.geliefert += n;
    }

    fn takte(&mut self, shared: &Mutex<Shared>, liefern: u32, anzahl: u32) {
        for _ in 0..anzahl {
            self.takt(shared, liefern);
        }
    }

    fn rueckstand(&self) -> u32 {
        self.erzeugt - self.geliefert
    }
}

/// Der Weg bis zum zweiten Aussetzer, gemeinsam fuer A/B/C: eingeschwungen,
/// erster Aussetzer (90 ms), ein Teilnachschub, von dem nach dem Verwerfen
/// 20 ms im Ring bleiben, dann der zweite Aussetzer (90 ms) — WAEHREND der
/// Ring noch vorfuellt. Den sieht die Positionspruefung nicht (Ring nicht leer).
fn zweiter_aussetzer_beim_vorfuellen(shared: &Mutex<Shared>) -> Strecke {
    let mut strecke = Strecke::default();
    strecke.takte(shared, 1, 60);
    strecke.takte(shared, 0, 9);
    strecke.takt(shared, 6);
    {
        let s = shared.lock().unwrap();
        assert!(s.anlauf, "Vorbedingung: noch im Vorfuellen");
        assert_eq!(s.ring.len(), 2 * PAKET_SAMPLES, "Vorbedingung: 20 ms im Ring");
    }
    strecke.takte(shared, 0, 9);
    strecke
}

/// Nach dem Aufholen: Ruhezeit der Grobkappung abwarten (echte Zeit, sie
/// liest die Uhr), dann gleichmaessig weiter. Der Ring muss auf dem Sollwert
/// stehen, und die Ausgabe laeuft ohne weitere Unterlaeufe.
fn nach_dem_aufholen_auf_dem_sollwert(shared: &Mutex<Shared>, strecke: &mut Strecke) {
    std::thread::sleep(std::time::Duration::from_millis(80));
    strecke.takte(shared, 1, 3);
    let unterlaeufe = shared.lock().unwrap().underruns;
    strecke.takte(shared, 1, 20);
    let s = shared.lock().unwrap();
    let soll = RING_SOLL_MS * TEST_PER_MS;
    assert_eq!(s.ring.len(), soll, "Ring nach dem Anhaengen auf dem Sollwert");
    assert!(s.regelung.resyncs >= 1, "der Ueberstand wurde geschnitten");
    assert_eq!(s.underruns, unterlaeufe);
}

/// Szenario A der Nachpruefung (2026-10-14): nach dem zweiten Aussetzer holt
/// das Netz troepfelnd auf, zwei Pakete je Takt. Der Ring laeuft dabei an und
/// steigt danach weiter — ohne Nachlauf blieb er rund 110 ms ueber dem
/// Sollwert, unter der normalen Kappschwelle.
#[test]
fn zweiter_aussetzer_troepfelnd_aufgeholt() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let mut strecke = zweiter_aussetzer_beim_vorfuellen(&shared);
    while strecke.rueckstand() > 0 {
        strecke.takt(&shared, 2);
    }
    nach_dem_aufholen_auf_dem_sollwert(&shared, &mut strecke);
}

/// Szenario B: Teilschwall (zehn Pakete auf einmal), der Rest troepfelt nach.
#[test]
fn zweiter_aussetzer_teilschwall_dann_aufgeholt() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let mut strecke = zweiter_aussetzer_beim_vorfuellen(&shared);
    strecke.takt(&shared, 10);
    while strecke.rueckstand() > 0 {
        strecke.takt(&shared, 2);
    }
    nach_dem_aufholen_auf_dem_sollwert(&shared, &mut strecke);
}

/// Szenario C: Teilschwall, danach ein Paket je Takt — der Rest bleibt im Netz
/// haengen, die Lieferung ist dauerhaft spaeter. Auch dann gehoert der Ring
/// auf den Sollwert: mehr Vorrat ist nur mehr Versatz.
#[test]
fn zweiter_aussetzer_teilschwall_rest_bleibt_haengen() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let mut strecke = zweiter_aussetzer_beim_vorfuellen(&shared);
    strecke.takt(&shared, 10);
    strecke.takte(&shared, 1, 10);
    assert!(strecke.rueckstand() > 0, "Vorbedingung: der Rest haengt noch");
    nach_dem_aufholen_auf_dem_sollwert(&shared, &mut strecke);
}

/// Faellt die Grenze mitten in ein Paket, wird nur sein Anfang verworfen —
/// und die Tonuhr traegt den Rest an der RICHTIGEN Marke ein: was jetzt
/// klingen muesste, ist genau der Anfang des Rests (der Ring haelt nur ihn,
/// gespielt ist noch nichts).
#[test]
fn ein_teilverwurf_rueckt_die_marke_nach() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let naechste = eingeschwungen(&shared);
    // 6 Aufrufe leeren den Ring, dann 25 ms Stille: zwei volle und ein halber.
    for _ in 0..8 {
        geraet(&shared);
    }
    let mut halb = vec![0.0f32; PAKET_SAMPLES / 2];
    fill_output(&shared, &mut halb);
    // Position jetzt: naechste + 25 ms = naechste + 1200 Takte.
    fuettern(&shared, (0..3).map(|k| naechste + k * PAKET_TAKTE));
    let s = shared.lock().unwrap();
    assert_eq!(s.ring.len(), PAKET_SAMPLES / 2, "vom dritten Paket bleibt die zweite Haelfte");
    assert_eq!(s.nachzuegler.verworfen, (2 * PAKET_SAMPLES + PAKET_SAMPLES / 2) as u64);
    let uhr = s.tonuhr.as_ref().unwrap();
    let position = uhr.position(s.ausgabe, 48_000, 2);
    let rest = f64::from(naechste + 1200);
    assert!((position - rest).abs() < 1.0, "Position {position} statt {rest}");
}

/// Ein Paket, das aelter ist als das zuletzt vermessene (umsortiert, doppelt,
/// reparierter Ton), wird verworfen — auch mitten im Betrieb — und laesst die
/// Tonuhr stehen. Angehaengt klaenge es nach neuerem Ton, und `Tonuhr::paket`
/// laese den Rueckschritt als Sprung um 2^32 Takte nach vorn.
#[test]
fn ein_aelteres_paket_wird_verworfen_und_die_tonuhr_bleibt() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let naechste = eingeschwungen(&shared);
    let zuletzt = shared.lock().unwrap().tonuhr.as_ref().unwrap().zuletzt();
    // Doppelt und zwei Pakete zu alt.
    fuettern(&shared, [naechste - PAKET_TAKTE, naechste - 3 * PAKET_TAKTE]);
    let s = shared.lock().unwrap();
    assert_eq!(s.tonuhr.as_ref().unwrap().zuletzt(), zuletzt, "kein Sprung der Tonuhr");
    assert_eq!(s.ring.len(), RING_SOLL_MS * TEST_PER_MS, "nichts angehaengt");
    assert_eq!(s.nachzuegler.verworfen, 2 * PAKET_SAMPLES as u64);
}

/// Springt die Zeitbasis um mehr als die Hoechstverspaetung zurueck (neuer
/// Sender), wird nicht verworfen, sondern neu verankert — sonst bliebe es
/// still, bis die Marken die alte Stelle wieder erreichen.
#[test]
fn ein_bruch_der_zeitbasis_verankert_die_tonuhr_neu() {
    let shared = shared_mit_soll(TEST_PER_MS);
    let naechste = eingeschwungen(&shared);
    let neu = naechste.wrapping_sub(48_000 * 3600);
    fuettern(&shared, [neu]);
    let s = shared.lock().unwrap();
    assert_eq!(s.tonuhr.as_ref().unwrap().zuletzt(), i64::from(neu), "neu verankert");
    assert_eq!(s.nachzuegler.verworfen, 0);
    assert_eq!(s.ring.len(), RING_SOLL_MS * TEST_PER_MS + PAKET_SAMPLES);
}

/// Ein `Shared` im Vorfuellen nach einem Unterlauf mit einer Tonuhr, nach der
/// bei `ausgabe` die Marke `position` klingt (Anker bei Marke 0).
fn nach_unterlauf_bei(ausgabe: u64) -> Mutex<Shared> {
    let shared = shared_mit_soll(TEST_PER_MS);
    {
        let mut s = shared.lock().unwrap();
        s.tonuhr = Some(lippen::Tonuhr::neu(0, 0, std::time::Instant::now(), 0.0));
        s.ausgabe = ausgabe;
    }
    shared
}

/// Bei Geraeteraten ungleich 48 kHz trifft die Rueckrechnung in Frames nicht
/// genau. Ein Ganzverwurf darf keinen Frame stehen lassen (88,2 kHz, ein Paket
/// mit 881 Frames = 479 Takte), ein Teilverwurf das Paket nicht leeren
/// (22,05 kHz, 220 Frames = 479 Takte, 478 davon verspaetet).
#[test]
fn ganz_heisst_ganz_und_teilweise_heisst_teilweise_bei_jeder_rate() {
    // 88,2 kHz: Position bei rund 1088 Takten, Paket ab 480 — ganz davor.
    let shared = nach_unterlauf_bei(4000);
    let mut s = shared.lock().unwrap();
    let mut paket = vec![0.0f32; 881 * 2];
    assert_eq!(s.verspaetetes_verwerfen(&mut paket, 480, 88_200, 2), None, "ganz weg");
    assert_eq!(s.nachzuegler.verworfen, 881 * 2);
    drop(s);

    // 22,05 kHz: Position bei 958 Takten, Paket 480 bis 959 — der letzte
    // Takt ist puenktlich, also bleibt ein Frame.
    let shared = nach_unterlauf_bei(881);
    let mut s = shared.lock().unwrap();
    let mut paket = vec![0.0f32; 220 * 2];
    let rest = s.verspaetetes_verwerfen(&mut paket, 480, 22_050, 2);
    assert_eq!(paket.len(), 2, "ein Frame bleibt");
    assert_eq!(rest, Some(480 + 477), "Marke um 219 Frames = 477 Takte weiter");
}

/// Der Opus-Decoder muss auf jeder Maschine oeffnen — sonst waere der
/// Tonpfad von der FFmpeg-Konfiguration abhaengig, ohne es zu merken.
#[test]
fn opus_decoder_laesst_sich_oeffnen() {
    let d = OpusDecoder::new(48_000, 2);
    assert!(d.is_ok(), "Opus-Decoder fehlt: {:?}", d.err());
}

/// Muell darf nicht panisch werden — nach einer Luecke kommen kaputte Pakete.
#[test]
fn kaputtes_paket_beendet_den_decoder_nicht() {
    let mut d = OpusDecoder::new(48_000, 2).expect("Decoder");
    let out = d.decode(&[0xFF, 0x00, 0x13, 0x37]);
    assert!(out.is_ok(), "kaputtes Paket darf keinen Fehler werfen");
}

/// Liest die rohen Opus-Pakete aus einer Ogg-Opus-Datei (ein Ogg-Paket =
/// ein Opus-Paket, ausser den zwei Kopf-Paketen). Erzeugung z.B.:
///   ffmpeg -f lavfi -i "sine=frequency=440:duration=2:sample_rate=48000" \
///     -ac 2 -c:a libopus -b:a 96k -f ogg ton_stereo.opus
fn opus_packets_from_ogg(path: &str) -> Vec<Vec<u8>> {
    ffmpeg::init().ok();
    let mut ictx = ffmpeg::format::input(path).expect("Ogg-Datei oeffnen");
    let audio_idx = ictx
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .expect("Audio-Stream in der Ogg-Datei")
        .index();
    ictx.packets()
        .filter(|(stream, _)| stream.index() == audio_idx)
        .filter_map(|(_, packet)| packet.data().map(|d| d.to_vec()))
        .collect()
}

/// RMS eines interleaved f32-Puffers (alle Kanaele zusammen).
fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Haelt einen BEHOBENEN Absturz fest: `resample_for_device()` griff bei
/// jeder Zielkanalzahl > 1 ueber das Ende der Slice hinaus.
/// `converted.plane::<f32>(0)` hat immer Laenge `converted.samples()`
/// (Anzahl Frames, nicht Frames*Kanaele) — auch fuer gepackte
/// Multi-Kanal-Formate —, gerechnet wurde aber
/// `converted.samples() * out_channels`:
///
///   thread panicked at src/audio.rs:309:37:
///   range end index 1920 out of range for slice of length 960
///
/// Das traf jedes reale Ausgabegeraet (fast nie Mono) beim ersten
/// Stereo-Paket. Behoben in `audio/opus.rs` (`converted.data(0)` statt der
/// Plane-Indizierung); der Nachbar-Test
/// `jede_zielkanalzahl_liefert_brauchbare_samples` haelt genau das fest.
///
/// **Bis zum 2026-08-27 stand hier „BEFUND (Bug, nicht behoben)".** Der Satz
/// hat den Fix ueberlebt — und ein Kommentar, der einen erledigten Absturz
/// als offen fuehrt, ist teurer als keiner: er laedt dazu ein, gegen ein
/// Gespenst zu entscheiden (etwa Mehrkanal-Ausgabe abzuschalten).
///
/// Env: PULSE_PLAYER_OPUS_STEREO_FIXTURE = Pfad zur .opus/.ogg-Datei
/// (2s, 440 Hz Sinus, Stereo, 48 kHz — siehe opus_packets_from_ogg()).
#[test]
fn echtes_stereo_opus_dekodiert_korrekt() {
    let Ok(fixture) = std::env::var("PULSE_PLAYER_OPUS_STEREO_FIXTURE") else {
        eprintln!("PULSE_PLAYER_OPUS_STEREO_FIXTURE nicht gesetzt — uebersprungen");
        return;
    };
    let packets = opus_packets_from_ogg(&fixture);
    assert!(!packets.is_empty(), "keine Opus-Pakete in der Fixture");

    let mut decoder = OpusDecoder::new(48_000, 2).expect("Decoder");
    let mut pcm = Vec::new();
    for p in &packets {
        pcm.extend(decoder.decode(p).expect("Decode echter Pakete"));
    }

    assert!(!pcm.is_empty(), "kein Ton dekodiert");
    assert_eq!(pcm.len() % 2, 0, "verschraenktes Stereo braucht gerade Anzahl");
    assert!(pcm.iter().all(|v| v.is_finite()), "NaN oder unendlich im Signal");

    // Inhaltlich: ein 440-Hz-Sinus ist weder stumm noch uebersteuert.
    let rms = (pcm.iter().map(|v| f64::from(*v) * f64::from(*v)).sum::<f64>()
        / pcm.len() as f64)
        .sqrt();
    assert!(rms > 0.05, "Signal praktisch stumm (RMS {rms:.4})");
    assert!(rms < 0.9, "Signal uebersteuert (RMS {rms:.4})");

    // Beide Kanaele muessen Signal tragen — waere die Verschraenkung falsch,
    // laege der Ton nur auf einer Seite oder die Haelfte waere null.
    let links: Vec<f32> = pcm.iter().step_by(2).copied().collect();
    let rechts: Vec<f32> = pcm.iter().skip(1).step_by(2).copied().collect();
    let energie = |c: &[f32]| c.iter().map(|v| f64::from(*v).abs()).sum::<f64>();
    assert!(energie(&links) > 0.0 && energie(&rechts) > 0.0, "ein Kanal ist stumm");
}

/// Gleiche Prüfung fuer Mono-Ausgabe (out_channels=1), damit die
/// plane()-Indizierung auch fuer den Nicht-Stereo-Fall belegt ist.
///
/// Env: PULSE_PLAYER_OPUS_MONO_FIXTURE = Pfad zu einer Mono-Opus-Datei.
#[test]
fn echtes_mono_opus_dekodiert_ohne_panik() {
    let Ok(fixture) = std::env::var("PULSE_PLAYER_OPUS_MONO_FIXTURE") else {
        eprintln!("PULSE_PLAYER_OPUS_MONO_FIXTURE nicht gesetzt — uebersprungen");
        return;
    };
    let packets = opus_packets_from_ogg(&fixture);
    assert!(!packets.is_empty(), "keine Opus-Pakete in der Fixture");

    let mut decoder = OpusDecoder::new(48_000, 1).expect("Decoder");
    let mut out = Vec::new();
    for p in &packets {
        let pcm = decoder.decode(p).expect("Decode darf bei echten Paketen nicht fehlschlagen");
        out.extend(pcm);
    }
    let level = rms(&out);
    assert!(level > 0.01, "Ton ist praktisch stumm, RMS={level}");
}

/// Regression, systematisch fuer mehrere Zielkanalzahlen: frueher stuerzte
/// jede Ausgabe ausser Mono ab, weil `plane::<f32>(0)` nur `samples()`
/// Elemente liefert (Frames ohne Kanalfaktor) und der Code auf
/// `samples * channels` schnitt. Nur out_channels=1 passte zufaellig.
///
/// Env: PULSE_PLAYER_OPUS_STEREO_FIXTURE wie oben.
#[test]
fn jede_zielkanalzahl_liefert_brauchbare_samples() {
    let Ok(fixture) = std::env::var("PULSE_PLAYER_OPUS_STEREO_FIXTURE") else {
        eprintln!("PULSE_PLAYER_OPUS_STEREO_FIXTURE nicht gesetzt — uebersprungen");
        return;
    };
    let packets = opus_packets_from_ogg(&fixture);
    assert!(!packets.is_empty(), "keine Opus-Pakete in der Fixture");

    for out_channels in [1u16, 2, 4, 6] {
        let mut decoder = OpusDecoder::new(48_000, out_channels).expect("Decoder");
        let pcm = decoder
            .decode(&packets[0])
            .unwrap_or_else(|e| panic!("out_channels={out_channels}: {e:#}"));
        assert!(!pcm.is_empty(), "out_channels={out_channels}: keine Samples");
        assert_eq!(
            pcm.len() % out_channels as usize,
            0,
            "out_channels={out_channels}: {} Werte sind kein Vielfaches der Kanalzahl",
            pcm.len()
        );
        assert!(
            pcm.iter().all(|v| v.is_finite() && v.abs() <= 1.5),
            "out_channels={out_channels}: Werte ausserhalb des Wertebereichs"
        );
    }
}

/// Testet die Kanalzahl-Wechsel-Frage aus dem Auftrag isoliert von Bug 1
/// oben: out_channels bleibt bei 1 (Mono-Ziel, dort crasht plane() nicht),
/// aber die QUELLE wechselt mitten im Stream von echten Mono- auf echte
/// Stereo-Opus-Pakete (zwei verschiedene, echte Encoder-Sessions). Der
/// Resampler in resample_for_device() wird nur beim ERSTEN Frame gebaut
/// und danach nie wieder geprueft — das hier prueft empirisch, ob ein
/// spaeterer Formatwechsel der QUELLE damit sauber bleibt oder crasht.
///
/// Env: PULSE_PLAYER_OPUS_STEREO_FIXTURE + PULSE_PLAYER_OPUS_MONO_FIXTURE.
#[test]
fn quellkanalzahl_wechsel_mitten_im_stream_bei_fixem_mono_ziel() {
    let (Ok(stereo_fixture), Ok(mono_fixture)) = (
        std::env::var("PULSE_PLAYER_OPUS_STEREO_FIXTURE"),
        std::env::var("PULSE_PLAYER_OPUS_MONO_FIXTURE"),
    ) else {
        eprintln!("Fixtures nicht gesetzt — uebersprungen");
        return;
    };
    let stereo_packets = opus_packets_from_ogg(&stereo_fixture);
    let mono_packets = opus_packets_from_ogg(&mono_fixture);
    assert!(!stereo_packets.is_empty() && !mono_packets.is_empty());

    // out_channels=1: Ziel bleibt Mono, damit Bug 1 (plane()-Index) hier
    // nicht zwischenfunkt. Es geht nur um den Resampler-Cache bei
    // wechselnder QUELL-Kanalzahl.
    let mut decoder = OpusDecoder::new(48_000, 1).expect("Decoder");
    let mut panicked = false;
    let mut decoded_before_switch = Vec::new();
    let mut decoded_after_switch = Vec::new();

    // Erst Mono-Pakete, damit der Resampler mit Mono-Eingang angelegt wird.
    for p in mono_packets.iter().take(10) {
        if let Ok(pcm) = decoder.decode(p) {
            decoded_before_switch.extend(pcm);
        }
    }

    // Jetzt Pakete aus einer FREMDEN Stereo-Session einspeisen — reale
    // Audioqualitaet ist irrelevant (der Decoder-Zustand passt ohnehin
    // nicht zur fremden Session), es geht nur darum, ob der Code mit
    // einem Kanalzahl-Wechsel der Quelle sauber umgeht statt zu crashen
    // oder die falsche Menge Speicher zu lesen.
    for p in stereo_packets.iter().take(10) {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decoder.decode(p))) {
            Ok(Ok(pcm)) => decoded_after_switch.extend(pcm),
            Ok(Err(e)) => eprintln!("decode() Fehler nach Kanalzahlwechsel: {e:?}"),
            Err(_) => {
                panicked = true;
                break;
            }
        }
    }

    eprintln!(
        "Quellkanalzahl-Wechsel (Ziel=Mono): decoded_before={} (RMS {:.4}), \
         panicked={panicked}, decoded_after={} (RMS {:.4})",
        decoded_before_switch.len(),
        rms(&decoded_before_switch),
        decoded_after_switch.len(),
        rms(&decoded_after_switch),
    );
    assert!(
        !panicked,
        "decode() panickt, wenn eine spaetere Quelle eine andere Kanalzahl \
         hat als beim ersten Resampler-Aufbau — auch bei festem Mono-Ziel. \
         Reproduktion: siehe Testkoerper (Mono-Fixture, dann Stereo-Fixture, \
         derselbe OpusDecoder)."
    );
    // Kein Crash ist nicht dasselbe wie richtiges Audio — zumindest darf
    // es nach dem Wechsel nicht komplett stumm/NaN sein (Anzeichen fuer
    // eine intern voellig falsch interpretierte Ebene).
    let level_after = rms(&decoded_after_switch);
    assert!(
        level_after.is_finite() && level_after > 0.0,
        "nach dem Quellkanalzahl-Wechsel kommt kein plausibles Signal mehr \
         heraus (RMS={level_after}) — deutet auf falsch interpretierte \
         Kanaldaten hin, auch ohne Absturz"
    );
}

/// Regression: ein einzelner PCM-Push kann selbst groesser sein als die
/// Ringgrenze. Wurde vor dem Anhaengen gekappt, reichte das Leeren des
/// Alt-Rings nicht und die Grenze blieb dauerhaft ueberschritten.
///
/// Ursache in pump_commands() (AudioCommand::Pcm-Zweig):
///   let drop_n = (total - max_ring_samples).min(s.ring.len());
///   s.ring.drain(..drop_n);
///   s.ring.extend(samples);
/// `drop_n` ist auf `s.ring.len()` gedeckelt — es kann also nie mehr
/// entfernt werden, als VOR dem Push schon im Ring lag. Ist die neue
/// Charge (`samples.len()`) allein schon groesser als max_ring_samples,
/// reicht das Leeren des kompletten Alt-Rings nicht aus: `extend(samples)`
/// haengt danach trotzdem die volle, ungekuerzte neue Charge an, und der
/// Ring landet bei `samples.len()` — weit ueber max_ring_samples.
///
/// Das widerspricht dem eigenen Kommentar auf MAX_RING_SECONDS
/// ("dann lieber verwerfen als Speicher fressen"): fuer diesen Fall
/// gilt die Speichergrenze nicht. Ob das in der Praxis erreichbar ist,
/// haengt daran, ob push() je mit einer einzelnen, ungewoehnlich grossen
/// Charge aufgerufen wird (z.B. Nachhol-Burst nach einer Pause im
/// aufrufenden Code) — hier bewusst mit kleinen Testzahlen belegt, damit
/// die Mechanik unabhaengig von realen Groessen sichtbar ist.
#[test]
fn grosser_einzelner_push_haelt_die_ringgrenze_ein() {
    // `target_fill: 0` ist hier Absicht: dieser Test prueft NUR die harte
    // Ringgrenze. Mit Sollwert liefe zusaetzlich die Rueckfuehrung an und
    // vermischte zwei Mechaniken in einer Zusicherung.
    let shared = Arc::new(shared_mit(0));
    let (tx, rx) = std::sync::mpsc::channel::<AudioCommand>();
    let max_ring_samples = 100usize;
    let per_ms = 10usize;

    let thread_shared = Arc::clone(&shared);
    let handle = std::thread::spawn(move || {
        // Rate und Kanalzahl sind hier belanglos — der Test schickt fertiges
        // PCM, der Decoder wird nie angelegt.
        pump_commands(&rx, &thread_shared, per_ms, max_ring_samples, 48_000, 2);
    });

    // Ein einzelner Push, zehnmal groesser als der erlaubte Ring.
    tx.send(AudioCommand::Pcm(vec![1.0; 1000], None)).unwrap();
    tx.send(AudioCommand::Stop).unwrap();
    handle.join().unwrap();

    let len = shared.lock().unwrap().ring.len();
    assert!(
        len <= max_ring_samples,
        "Ring haelt {len} Samples, erlaubt sind {max_ring_samples}"
    );
}

/// Rechnet target_fill vs. max_ring_samples fuer die Grenzwerte von
/// av_offset_ms (0..=2000, per Clamp in set_offset_ms) nach, statt es
/// nur zu behaupten.
#[test]
fn target_fill_bleibt_innerhalb_der_ringgrenze() {
    for (sample_rate, channels) in [(48_000u32, 2u16), (44_100, 2), (48_000, 6), (96_000, 8)] {
        let max_ring_samples = MAX_RING_SECONDS * sample_rate as usize * channels as usize;
        let per_ms = (sample_rate as usize * channels as usize) / 1000;
        for ms in [0i32, 1, 500, 2000] {
            // Dieselbe Rechnung wie in `pump_commands` — seit 2026-08-05
            // MIT dem Sollwert, der Trim ist nur noch ein Zuschlag. Ohne
            // ihn hier mitzuziehen, prueft der Test eine Formel nach, die
            // es nicht mehr gibt.
            let target_fill =
                ((RING_SOLL_MS + ms.max(0) as usize) * per_ms).min(max_ring_samples / 2);
            // Erreichbar sein muss er: der Callback startet erst, wenn
            // ring.len() >= target_fill, und der Ring wird bei
            // max_ring_samples gekappt.
            assert!(
                target_fill <= max_ring_samples,
                "rate={sample_rate} ch={channels} ms={ms}: target_fill={target_fill} \
                 > max_ring_samples={max_ring_samples} — waere nie erreichbar"
            );
        }
    }
}
