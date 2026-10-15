//! Tests der Verlust-Verdeckung (`audio/verdeckung.rs`).

use super::*;
use ffmpeg_next as ffmpeg;

/// CELT, Vollband, 10 ms, Stereo, Code 0 — das, was die Sender schicken.
const TOC_CELT_10MS: u8 = 0xF4;
const RAHMEN: u32 = 480;
/// 48 kHz Stereo.
const PER_MS: usize = 96;

fn paket() -> Vec<u8> {
    vec![TOC_CELT_10MS, 0x11, 0x22]
}

fn lage(ring_ms: usize, abruf_vor: Duration, jetzt: Instant) -> Lage {
    Lage {
        ring: ring_ms * PER_MS,
        abruf: 10 * PER_MS,
        abruf_zeit: Some(jetzt - abruf_vor),
        soll: 60 * PER_MS,
        per_ms: PER_MS,
        anlauf: false,
    }
}

/// Mit Paketen 0..n (je 10 ms) gefuettert.
fn gefuettert(n: u32) -> Verdeckung {
    let mut v = Verdeckung::default();
    for k in 0..n {
        echt(&mut v, k * RAHMEN);
    }
    v
}

/// Ein Paket, das behalten und (wie in `fuetterung`) dekodiert angehaengt wird.
fn echt(v: &mut Verdeckung, rtp: u32) -> bool {
    let behalten = v.echtes_paket(&paket(), Some(rtp));
    if behalten {
        v.angehaengt(&paket(), Some(rtp));
    }
    behalten
}

#[test]
fn dauer_aus_dem_toc() {
    assert_eq!(takte(&[TOC_CELT_10MS]), Some(480), "CELT 10 ms");
    assert_eq!(takte(&[0x74]), Some(480), "Hybrid 10 ms");
    assert_eq!(takte(&[(1 << 3) | 1]), Some(1920), "SILK 20 ms, zwei Rahmen");
    assert_eq!(takte(&[(16 << 3) | 3, 3]), Some(360), "CELT 2,5 ms, drei Rahmen");
    assert_eq!(takte(&[(16 << 3) | 3, 0]), None, "Code 3 ohne Rahmen");
    assert_eq!(takte(&[(16 << 3) | 3]), None, "Code 3 ohne Zaehlbyte");
    assert_eq!(takte(&[]), None);
}

/// Ohne Verlust: jedes Paket bleibt, und solange der Ring den naechsten
/// Abruf deckt, wird nur gewartet.
#[test]
fn ohne_verlust_aendert_sich_nichts() {
    let v = gefuettert(100);
    assert_eq!(v.zaehler.ersetzt, 0);
    let jetzt = Instant::now();
    for vor_ms in [0, 5, 7, 9, 30] {
        let schritt = v.entscheiden(&lage(10, Duration::from_millis(vor_ms), jetzt), jetzt);
        assert!(matches!(schritt, Schritt::Warten(_)), "{vor_ms} ms: {schritt:?}");
    }
}

/// Reicht der Ring nicht fuer den naechsten Abruf, wird erst kurz davor
/// verdeckt — ein Paket, das bis dahin noch kommt, wird nicht ersetzt.
#[test]
fn verdeckt_wird_erst_kurz_vor_dem_abruf() {
    let v = gefuettert(3);
    let jetzt = Instant::now();
    match v.entscheiden(&lage(4, Duration::from_millis(2), jetzt), jetzt) {
        Schritt::Warten(d) => assert_eq!(d, Duration::from_millis(5), "10 - 2 - Vorlauf 3"),
        s => panic!("zu frueh verdeckt: {s:?}"),
    }
    let schritt = v.entscheiden(&lage(4, Duration::from_millis(7), jetzt), jetzt);
    assert_eq!(schritt, Schritt::Verdecken(TOC_CELT_10MS));
    // Ein ueberfaelliger Abruf (Geraet hakt) verdeckt ebenfalls.
    let schritt = v.entscheiden(&lage(0, Duration::from_millis(40), jetzt), jetzt);
    assert_eq!(schritt, Schritt::Verdecken(TOC_CELT_10MS));
}

/// Nichts vor dem ersten Paket, nichts im Anlauf, nichts ohne bekannten
/// Abruftakt, nichts bei einem Abruf ueber dem Sollwert.
#[test]
fn wann_nicht_verdeckt_wird() {
    let jetzt = Instant::now();
    let knapp = lage(0, Duration::from_millis(9), jetzt);
    assert!(matches!(Verdeckung::default().entscheiden(&knapp, jetzt), Schritt::Warten(_)));
    let v = gefuettert(1);
    let im_anlauf = Lage { anlauf: true, ..lage(0, Duration::from_millis(9), jetzt) };
    assert!(matches!(v.entscheiden(&im_anlauf, jetzt), Schritt::Warten(_)));
    let ohne_takt = Lage { abruf_zeit: None, ..lage(0, Duration::from_millis(9), jetzt) };
    assert!(matches!(v.entscheiden(&ohne_takt, jetzt), Schritt::Warten(_)));
    let riesig = Lage { abruf: 80 * PER_MS, ..lage(0, Duration::from_millis(79), jetzt) };
    assert!(matches!(v.entscheiden(&riesig, jetzt), Schritt::Warten(_)));
}

/// Nach drei verdeckten Rahmen kommen die echten Pakete doch noch (Schwall
/// nach Nachlieferung): die drei verdeckten fallen weg, das vierte bleibt, und
/// danach ist die Verdeckung beendet.
#[test]
fn verdeckte_zeit_wird_nicht_doppelt_gespielt() {
    let mut v = gefuettert(10);
    for _ in 0..3 {
        v.verdeckt(TOC_CELT_10MS, true);
    }
    for k in 10..13 {
        assert!(!echt(&mut v, k * RAHMEN), "Paket {k} ist verdeckt");
    }
    assert!(echt(&mut v, 13 * RAHMEN));
    assert!(echt(&mut v, 14 * RAHMEN));
    assert_eq!((v.zaehler.verdeckt, v.zaehler.plc, v.zaehler.ersetzt), (3, 3, 3));
    assert_eq!(v.lauf, 0);
}

/// Ein nur angeschnittenes Paket (Marke des Senders um weniger als einen
/// halben Rahmen versetzt) bleibt; ein Sprung weit zurueck (neuer Sender) ist
/// kein Nachzuegler, ebenso ein Paket nach einer Sender-Pause.
#[test]
fn angeschnitten_neu_oder_nach_pause_bleibt() {
    let mut v = gefuettert(10);
    v.verdeckt(TOC_CELT_10MS, false);
    // Verdeckt bis 11*480; Paket beginnt 4 ms vor dem Ende.
    assert!(echt(&mut v, 11 * RAHMEN - 192));

    let mut v = gefuettert(10);
    v.verdeckt(TOC_CELT_10MS, false);
    assert!(echt(&mut v, 0u32.wrapping_sub(48_000)), "Ruecksprung");

    let mut v = gefuettert(10);
    v.verdeckt(TOC_CELT_10MS, false);
    assert!(echt(&mut v, 500 * RAHMEN), "Sender-Pause");
}

/// Ueber RTP-Wrap hinweg rechnet der Vergleich richtig.
#[test]
fn ueber_den_wrap() {
    let mut v = Verdeckung::default();
    let start = u32::MAX - RAHMEN + 1;
    assert!(echt(&mut v, start));
    v.verdeckt(TOC_CELT_10MS, true);
    assert!(!echt(&mut v, start.wrapping_add(RAHMEN)));
    assert!(echt(&mut v, start.wrapping_add(2 * RAHMEN)));
}

/// Hoechstens 120 ms am Stueck, dann laeuft der Ring leer wie bisher.
#[test]
fn hoechstens_am_stueck() {
    let mut v = gefuettert(1);
    let jetzt = Instant::now();
    let knapp = lage(0, Duration::from_millis(9), jetzt);
    let mut n = 0;
    while v.entscheiden(&knapp, jetzt) == Schritt::Verdecken(TOC_CELT_10MS) {
        v.verdeckt(TOC_CELT_10MS, true);
        n += 1;
        assert!(n <= 100, "endlos");
    }
    assert_eq!(n * RAHMEN, HOECHSTENS_TAKTE);
    // Ein echtes Paket beendet den Lauf, danach geht es wieder.
    assert!(echt(&mut v, 500 * RAHMEN));
    assert_eq!(v.entscheiden(&knapp, jetzt), Schritt::Verdecken(TOC_CELT_10MS));
}

/// Durch den Ring: ohne Decoder wird mit Stille aufgefuellt, bis der naechste
/// Abruf gedeckt ist — und bei ausreichendem Ring passiert nichts.
#[test]
fn fuellt_den_ring_bis_zum_naechsten_abruf() {
    let shared = crate::audio::tests::shared_mit(60 * PER_MS);
    let mut v = gefuettert(5);
    {
        let mut s = shared.lock().unwrap();
        s.anlauf = false;
        s.ring.extend(std::iter::repeat_n(0.5, 4 * PER_MS));
        s.verdeckung.abruf(10 * PER_MS, Instant::now() - Duration::from_millis(9));
    }
    luecke_fuellen(&shared, None, &mut v, 48_000, 2);
    let s = shared.lock().unwrap();
    assert_eq!(s.ring.len(), 14 * PER_MS, "ein Rahmen Stille angehaengt");
    assert!(s.ring.iter().skip(4 * PER_MS).all(|&x| x == 0.0));
    assert_eq!((s.verdeckung.zaehler.verdeckt, s.verdeckung.zaehler.plc), (1, 0));
    drop(s);

    // Genug im Ring: nichts.
    luecke_fuellen(&shared, None, &mut v, 48_000, 2);
    assert_eq!(shared.lock().unwrap().ring.len(), 14 * PER_MS);
}

// --- Mit echtem Decoder -------------------------------------------------

/// Opus-Pakete wie vom Sender (128 kbit/s, 10 ms, FEC an, 5 % erwarteter
/// Verlust): ein Akkord mit Schwebung. `None`, wenn dieses FFmpeg keinen
/// libopus-Encoder hat.
fn sender_pakete(anzahl: usize) -> Option<Vec<Vec<u8>>> {
    use ffmpeg::format::{sample::Type, Sample};
    ffmpeg::init().ok();
    let codec = ffmpeg::encoder::find_by_name("libopus")?;
    let mut enc = ffmpeg::codec::context::Context::new_with_codec(codec).encoder().audio().ok()?;
    enc.set_format(Sample::F32(Type::Packed));
    enc.set_rate(48_000);
    enc.set_channel_layout(ffmpeg::ChannelLayout::STEREO);
    enc.set_bit_rate(128_000);
    enc.set_time_base(ffmpeg::Rational::new(1, 48_000));
    let mut opt = ffmpeg::Dictionary::new();
    opt.set("frame_duration", "10");
    opt.set("fec", "1");
    opt.set("packet_loss", "5");
    let mut enc = enc.open_with(opt).ok()?;
    let mut frame = ffmpeg::frame::Audio::new(
        Sample::F32(Type::Packed),
        480,
        ffmpeg::ChannelLayout::STEREO,
    );
    frame.set_rate(48_000);
    let mut pakete = Vec::new();
    let mut packet = ffmpeg::Packet::empty();
    for k in 0..anzahl + 10 {
        let bytes = frame.data_mut(0);
        for i in 0..480 {
            let t = (k * 480 + i) as f32 / 48_000.0;
            let tau = std::f32::consts::TAU;
            let l = 0.3 * (tau * 220.0 * t).sin() * (0.5 + 0.5 * (tau * 3.0 * t).sin())
                + 0.2 * (tau * 330.0 * t).sin();
            let r = 0.3 * (tau * 277.0 * t).sin() + 0.2 * (tau * 440.0 * t).sin();
            bytes[i * 8..i * 8 + 4].copy_from_slice(&l.to_ne_bytes());
            bytes[i * 8 + 4..i * 8 + 8].copy_from_slice(&r.to_ne_bytes());
        }
        frame.set_pts(Some((k * 480) as i64));
        enc.send_frame(&frame).ok()?;
        while enc.receive_packet(&mut packet).is_ok() {
            pakete.extend(packet.data().map(<[u8]>::to_vec));
        }
    }
    pakete.truncate(anzahl);
    (pakete.len() == anzahl).then_some(pakete)
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

/// Groesster Sprung zwischen zwei aufeinanderfolgenden Samples desselben
/// Kanals (verschraenktes Stereo).
fn groesster_sprung(x: &[f32]) -> f32 {
    x.windows(3).map(|w| (w[2] - w[0]).abs()).fold(0.0, f32::max)
}

/// **Die Messung hinter `OpusDecoder::verdecken`**: drei Rahmen per
/// TOC-Paket verdecken, mit beiden Decodern, soweit dieses FFmpeg sie hat.
/// libopus setzt das Signal fort, FFmpegs eigener Decoder klingt aus; beide
/// steigen ohne Knack wieder ein (kein Sprung groesser als im Signal selbst).
#[test]
fn decoder_verdeckt_ueber_das_toc_paket() {
    let Some(pakete) = sender_pakete(80) else {
        eprintln!("kein libopus-Encoder in diesem FFmpeg — uebersprungen");
        return;
    };
    let celt = pakete.iter().filter(|p| p[0] >> 3 >= 16).count();
    eprintln!("CELT-only: {celt} von {}", pakete.len());
    for name in ["libopus", "opus"] {
        let Ok(mut d) = OpusDecoder::mit(&[name], 48_000, 2) else { continue };
        assert_eq!(d.mit_plc(), name == "libopus");
        let mut ton = Vec::new();
        for p in &pakete[..50] {
            ton.extend(d.decode(p).expect("echtes Paket"));
        }
        let vorher = rms(&ton[ton.len() - 960..]);
        let max_im_signal = groesster_sprung(&ton[960 * 10..]);
        let mut ersatz = Vec::new();
        for _ in 0..3 {
            let pcm = d.verdecken(pakete[49][0]).expect("Ersatzrahmen");
            assert_eq!(pcm.len(), 960, "{name}: ein Rahmen 10 ms Stereo");
            assert!(pcm.iter().all(|v| v.is_finite()));
            ersatz.push(pcm);
        }
        let danach = d.decode(&pakete[53]).expect("echtes Paket nach dem Verlust");
        eprintln!(
            "{name}: vorher {vorher:.3}, Ersatz {:.3} {:.3} {:.3}, danach {:.3}",
            rms(&ersatz[0]),
            rms(&ersatz[1]),
            rms(&ersatz[2]),
            rms(&danach)
        );
        if name == "libopus" {
            assert!(rms(&ersatz[0]) > 0.5 * vorher, "PLC setzt das Signal fort");
        } else {
            assert!(rms(&ersatz[2]) < 1e-3, "eigener Decoder: Stille");
        }
        // Uebergaenge: echt -> Ersatz und Ersatz -> echt, je 8 Frames beidseits.
        let rein = [&ton[ton.len() - 16..], &ersatz[0][..16]].concat();
        let raus = [&ersatz[2][960 - 16..], &danach[..16]].concat();
        for (wo, stelle) in [("Beginn", rein), ("Ende", raus)] {
            let sprung = groesster_sprung(&stelle);
            eprintln!("{name}: {wo}: Sprung {sprung:.4}, im Signal bis {max_im_signal:.4}");
            assert!(
                sprung <= 1.5 * max_im_signal,
                "{name}: Knack am {wo} der Verdeckung ({sprung:.3} gegen {max_im_signal:.3})"
            );
        }
    }
}

/// Ein Zeitbasis-Bruch mit beliebigem Abstand waehrend einer Verdeckung darf
/// weder ueberlaufen noch faelschlich verwerfen (Nachpruefung 2026-10-15:
/// `ueberlapp * 2` lief in i32 ueber).
#[test]
fn extremer_abstand_laeuft_nicht_ueber() {
    for sprung in [i32::MIN as u32, i32::MAX as u32, 0x8000_0001, 0x7FFF_FF00] {
        let mut v = gefuettert(10);
        v.verdeckt(TOC_CELT_10MS, true);
        let ende = 11 * RAHMEN;
        assert!(echt(&mut v, ende.wrapping_sub(sprung)), "Abstand {sprung:#x}");
    }
}

/// Ohne RTP-Marken wird nicht verdeckt — spaeter Ton liesse sich nicht als
/// verdeckt erkennen und klaenge doppelt.
#[test]
fn ohne_marken_kein_ersatzton() {
    let mut v = Verdeckung::default();
    assert!(v.echtes_paket(&paket(), None));
    v.angehaengt(&paket(), None);
    let jetzt = Instant::now();
    let knapp = lage(0, Duration::from_millis(9), jetzt);
    assert!(matches!(v.entscheiden(&knapp, jetzt), Schritt::Warten(_)));
}

/// Scheitert das Dekodieren (kein `angehaengt`), bleibt das Ringende, wo es
/// war: das Paket ist nie im Ring angekommen.
#[test]
fn gescheiterter_decode_verschiebt_das_ende_nicht() {
    let mut v = gefuettert(10);
    v.verdeckt(TOC_CELT_10MS, true);
    let ende = v.ende;
    assert!(v.echtes_paket(&paket(), Some(11 * RAHMEN)));
    assert_eq!(v.ende, ende);
    assert_eq!(v.lauf, RAHMEN, "Lauf bleibt offen");
}
