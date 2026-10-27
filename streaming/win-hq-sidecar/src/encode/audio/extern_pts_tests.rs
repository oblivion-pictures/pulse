use super::*;

/// Der containerlose Weg (WHIP/Direct) ruft `set_stream_time_base` NIE —
/// die pts der Tonpakete muessen dort trotzdem in SAMPLES ankommen, denn
/// `senke_writer::ton_dauer_aus_pts` teilt den PTS-Sprung durch die
/// Abtastrate. Bis 0.1.90 stand der Platzhalter auf dem FLV-Default
/// (1/1000): jeder Sprung kam in Millisekunden, jedes 10-ms-Paket bekam
/// 1 ms Dauer, die Ton-RTP-Uhr lief mit einem Zehntel der Echtzeit, und
/// der Bild/Ton-Versatz wuchs um ~0,9 s je gestreamter Sekunde — AMD wie
/// NVIDIA, auch im Browser sichtbar. Die Tests an `ton_dauer_aus_pts`
/// fuettern die reine Funktion mit Sample-Skala und pruefen damit nur
/// ihre Annahme; dieser Test nagelt die Skala fest, die wirklich ankommt.
#[test]
fn ohne_container_bleiben_die_pts_in_samples() {
    let rate = 48_000;
    let mut p = AudioPipeline::create(None, rate, 2, 128, 0).unwrap();
    let frames_je_paket = (rate as usize / 1000) * opus_frame_ms();
    let chunk = CapturedAudio {
        format: crate::audio::AudioFormat {
            sample_rate: rate,
            channels: 2,
            bits_per_sample: 32,
        },
        bytes: vec![0u8; frames_je_paket * 8],
        frames: frames_je_paket as u32,
        captured_at: std::time::Instant::now(),
        qpc: 0,
        aufnahme: crate::audio::aufnahmebuch::Aufnahmezeit::Unbekannt,
    };
    let mut pts = Vec::new();
    for _ in 0..3 {
        for paket in p.send(&chunk).unwrap() {
            pts.push(paket.pts().unwrap());
        }
    }
    assert!(
        pts.len() >= 2,
        "libopus muss je Frame ein Paket liefern, sonst prueft der Test nichts"
    );
    for paar in pts.windows(2) {
        assert_eq!(
            paar[1] - paar[0],
            frames_je_paket as i64,
            "PTS-Sprung in Sample-Skala erwartet — Millisekunden sind der 0.1.90er-Fehler"
        );
    }
}
