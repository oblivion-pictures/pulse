//! Volle Farbaufloesung (4:4:4): `convert` und der Weg durch den Decoder.
//!
//! Eigene Datei, weil `decode.rs` weit ueber der Groessengrenze liegt.

use ffmpeg::format::Pixel;
use ffmpeg_next as ffmpeg;

use super::{convert, PixelLayout, PlanePool, VideoDecoder};
use crate::whep::Codec;

/// Ein Bild in `format` mit unterscheidbarem Inhalt je Ebene und Zeile.
fn bild(format: Pixel, breite: u32, hoehe: u32) -> ffmpeg::util::frame::video::Video {
    let mut f = ffmpeg::util::frame::video::Video::new(format, breite, hoehe);
    for i in 0..f.planes() {
        let stride = f.stride(i);
        for (n, b) in f.data_mut(i).iter_mut().enumerate() {
            *b = (i * 50 + n / stride + n % 7) as u8;
        }
    }
    f
}

/// Die drei 4:4:4-Formate werden angenommen, und die Farbebenen kommen in
/// VOLLER Hoehe heraus. Ungerade Masse, damit eine Halbierung irgendwo im Weg
/// auffiele (die waere bei 241 Zeilen 121, nicht 241).
#[test]
fn convert_nimmt_volle_farbaufloesung_an() {
    let pool = PlanePool::default();
    let (w, h) = (321u32, 241u32);
    for (format, layout, zehn_bit, ebenen) in [
        (Pixel::YUV444P, PixelLayout::Planar444, false, 3),
        (Pixel::YUV444P10LE, PixelLayout::Planar444, true, 3),
        (Pixel::NV24, PixelLayout::BiPlanar444, false, 2),
    ] {
        let quelle = bild(format, w, h);
        let f = convert(&quelle, &pool).unwrap_or_else(|| panic!("{format:?} abgelehnt"));
        assert_eq!(f.format, layout, "{format:?}");
        assert_eq!(f.ten_bit, zehn_bit, "{format:?}");
        assert_eq!(f.planes.len(), ebenen, "{format:?}");
        assert_eq!(f.farbe.matrix, crate::decode::ColorMatrix::Bt601, "{format:?}: 241 Zeilen");
        for i in 0..ebenen {
            let stride = quelle.stride(i);
            assert_eq!(f.strides[i], stride, "{format:?} Ebene {i}: Zeilenabstand");
            // Jede Ebene traegt alle Zeilen — auch die Farbebenen.
            assert_eq!(f.planes[i].len(), stride * h as usize, "{format:?} Ebene {i}");
            assert_eq!(f.planes[i][..], quelle.data(i)[..stride * h as usize], "{format:?} {i}");
        }
    }
}

/// Gegenprobe: 4:2:0 bleibt bei halber Farbhoehe (aufgerundet).
#[test]
fn convert_halbiert_bei_420_weiter() {
    let pool = PlanePool::default();
    let quelle = bild(Pixel::YUV420P, 321, 241);
    let f = convert(&quelle, &pool).expect("YUV420P");
    assert_eq!(f.format, PixelLayout::Planar420);
    assert_eq!(f.planes[1].len(), quelle.stride(1) * 121);
}

#[test]
fn farbmasse_je_layout() {
    assert_eq!(PixelLayout::Planar420.farbmasse(321, 241), (161, 121));
    assert_eq!(PixelLayout::BiPlanar420.farbmasse(321, 241), (161, 121));
    assert_eq!(PixelLayout::Planar444.farbmasse(321, 241), (321, 241));
    assert_eq!(PixelLayout::BiPlanar444.farbmasse(321, 241), (321, 241));
    assert!(PixelLayout::Planar444.planar() && !PixelLayout::BiPlanar444.planar());
}

/// **Ende-zu-Ende ohne Netz:** ein echter 4:4:4-Strom durch denselben
/// `VideoDecoder` wie im Betrieb (Kandidatenliste, Ruecklesen, Zero-Copy-
/// Versuch mit echtem wgpu-Geraet, `convert`), Bild fuer Bild verglichen mit
/// einer Referenz, die ein unabhaengiger Decoder geschrieben hat. Die
/// Farbebenen muessen Punkt fuer Punkt stimmen — eine halbierte und wieder
/// aufgeblasene Farbe fiele an jeder farbigen Kante auf.
///
/// Laeuft nur mit `PULSE_PLAYER_444_FIXTURE` (roher Strom: `.hevc`, `.h264`
/// oder `.obu`) und `PULSE_PLAYER_444_REFERENZ` (`rawvideo` im Pixelformat
/// des Stroms). Die Crate bringt bewusst keine Mediendatei mit. Erzeugen:
///
/// ```text
/// ffmpeg -f lavfi -i testsrc2=s=1280x720:r=30:d=1 \
///   -vf scale=out_color_matrix=bt601:out_range=tv,format=yuv444p \
///   -c:v hevc_nvenc -profile:v rext -bf 0 -f hevc x.hevc
/// ffmpeg -i x.hevc -f rawvideo -pix_fmt yuv444p x.hevc.yuv
/// ```
///
/// `PULSE_PLAYER_TEST_HW=0` verbietet Hardware (fuer H.264/AV1 in Software);
/// `PULSE_PLAYER_DECODER` waehlt den Kandidaten wie im Betrieb.
#[test]
fn strom_444_kommt_punktgenau_an() {
    let (Ok(strom), Ok(referenz)) = (
        std::env::var("PULSE_PLAYER_444_FIXTURE"),
        std::env::var("PULSE_PLAYER_444_REFERENZ"),
    ) else {
        eprintln!("uebersprungen: PULSE_PLAYER_444_FIXTURE/_REFERENZ nicht gesetzt");
        return;
    };
    let codec = match strom.rsplit('.').next() {
        Some("hevc") => Codec::H265,
        Some("h264") => Codec::H264,
        Some("obu") => Codec::Av1,
        _ => panic!("Endung von {strom} unbekannt (.hevc/.h264/.obu)"),
    };
    let hw = std::env::var("PULSE_PLAYER_TEST_HW").as_deref() != Ok("0");
    let referenz = std::fs::read(&referenz).expect("Referenz lesbar");

    let mut d = VideoDecoder::new(codec, Some(hw), wgpu_geraet()).expect("Decoder");
    let anfang = (d.name.clone(), d.kandidat_nr);
    let mut input = ffmpeg::format::input(&strom).expect("Strom lesbar");
    let mut verglichen = 0usize;
    let mut zurueckgelesen = false;
    for (paket_nr, (_, paket)) in input.packets().enumerate() {
        let Some(daten) = paket.data() else { continue };
        let bilder = d.decode(daten).expect("decode");
        zurueckgelesen |= d.hw_ziel.planes() > 0;
        // Bei HEVC haette die Schranke (`lizenzlinie`) weitergeschaltet. Bei
        // H.264/AV1 ist ein Wechsel erlaubt: NVDEC kann dort kein 4:4:4, und
        // der Neuaufbau geht auf Software.
        if codec == Codec::H265 {
            assert_eq!((d.name.clone(), d.kandidat_nr), anfang, "Decoder gewechselt");
        }
        for f in bilder {
            assert!(f.gpu.is_none(), "4:4:4 darf nicht ueber Zero-Copy kommen");
            assert_eq!(f.format, PixelLayout::Planar444, "Bild {verglichen}");
            // Welches Referenzbild es ist, sagt die Paketnummer — cuvid gibt
            // eines verzoegert heraus, und nach einem Neuaufbau fehlen die
            // Bilder bis zum naechsten Vollbild. Jedes Testbild ist anders
            // (laufender Zaehler), ein Treffer ist also eindeutig.
            let treffer = (paket_nr.saturating_sub(3)..=paket_nr)
                .rev()
                .find_map(|nr| abweichung(&f, &referenz, nr).is_none().then_some(nr));
            if treffer.is_none() {
                panic!("Paket {paket_nr}: {}", abweichung(&f, &referenz, paket_nr).unwrap());
            }
            verglichen += 1;
        }
    }
    eprintln!(
        "{strom}: Decoder {} (hardware={}), {verglichen} Bilder punktgenau, \
         Ruecklesen aus dem Grafikspeicher: {zurueckgelesen}",
        d.name, d.hardware
    );
    assert!(verglichen >= 20, "zu wenige Bilder: {verglichen}");
}

/// Bild `nr` gegen die Referenz — Zeile fuer Zeile, ohne den Fuellbereich
/// hinter jeder Zeile (der Zeilenabstand des Decoders ist groesser). `None`
/// heisst gleich, sonst steht die erste Abweichung darin.
fn abweichung(f: &super::DecodedFrame, referenz: &[u8], nr: usize) -> Option<String> {
    let bps = if f.ten_bit { 2 } else { 1 };
    let zeile = f.width as usize * bps;
    let ebene = zeile * f.height as usize;
    let anfang = nr * 3 * ebene;
    let Some(soll_bild) = referenz.get(anfang..anfang + 3 * ebene) else {
        return Some(format!("Referenz hat kein Bild {nr}"));
    };
    for (i, (ist, &stride)) in f.planes.iter().zip(&f.strides).enumerate() {
        for y in 0..f.height as usize {
            let soll = &soll_bild[i * ebene + y * zeile..][..zeile];
            let ist = &ist[y * stride..][..zeile];
            if ist != soll {
                let x = ist.iter().zip(soll).position(|(a, b)| a != b).unwrap_or(0) / bps;
                return Some(format!("Bild {nr}, Ebene {i}, Zeile {y}, Spalte {x} weicht ab"));
            }
        }
    }
    None
}

/// Ein echtes wgpu-Geraet, damit der Zero-Copy-Versuch so laeuft wie im
/// Fenster. Ohne GPU ohne Geraet — dann wird die Bruecke gar nicht gebaut.
fn wgpu_geraet() -> Option<wgpu::Device> {
    let instance = crate::render::ohne_anzeige();
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).ok()?;
    let (device, _queue, _) =
        pollster::block_on(crate::render::geraet_oeffnen(&adapter, "pulse-player-444-test")).ok()?;
    Some(device)
}
