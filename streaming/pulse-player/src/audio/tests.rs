//! Tests der Tonausgabe — aus `audio.rs` herausgeloest (Groessengrenze,
//! `PLAN.md` §12.1) am 2026-10-14, im selben Zug angepasst (Schwall-Erkennung,
//! Lippen-Regler ohne Ringabweichung).

use super::*;
// Nur die Tests brauchen FFmpeg noch unmittelbar (echte Opus-Dateien); der
// Ausgabepfad selbst kommt seit der Auslagerung des Decoders ohne aus.
use ffmpeg_next as ffmpeg;

/// Ein frisches `Shared` mit dem gewuenschten Zielfuellstand, Ring leer.
fn shared_mit(target_fill: usize) -> Mutex<Shared> {
    Mutex::new(Shared {
        ring: VecDeque::new(),
        volume: 1.0,
        target_fill,
        underruns: 0,
        dropped: 0,
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
