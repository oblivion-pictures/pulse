//! Tonausgabe ueber cpal — unter Windows und macOS der einzige Weg, unter
//! Linux der Rueckfall, wenn PipeWire nicht erreichbar ist
//! (s. [`super::ausgabe_pipewire`]). Aus `audio.rs` herausgeloest am
//! 2026-10-22, als der PipeWire-Weg dazukam.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context as _, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::{fill_output, fuettern, AudioCommand, Shared, OPUS_SAMPLE_RATE};

/// Standard-Ausgabegeraet, Format und Name des Wegs (cpal-Host: "ALSA",
/// "WASAPI", "CoreAudio") waehlen. Schlaegt das fehl, laeuft die Sitzung stumm
/// weiter (s. `AudioOutput::new`).
pub(super) fn oeffnen() -> Result<(cpal::Device, cpal::StreamConfig, &'static str)> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow!("kein Standard-Ausgabegeraet"))?;
    let default_config = device
        .default_output_config()
        .context("Standard-Ausgabeformat nicht abfragbar")?;
    // 48 kHz bevorzugen — Opus liefert IMMER 48 kHz.
    //
    // `default_output_config()` meldet unter ALSA gern 44100, unabhaengig
    // davon, was darunter wirklich laeuft. Am 2026-08-03 auf der
    // Dev-Maschine gemessen: PipeWire fuhr `clock.rate=48000` und liess mit
    // `allowed-rates=[48000]` gar nichts anderes zu, das Headset ebenfalls
    // 48000 — der Player waehlte trotzdem 44100. Der Ton wurde also von
    // 48000 auf 44100 heruntergerechnet und gleich darauf wieder hoch, mit
    // einem krummen Verhaeltnis in beide Richtungen. Hoerbar als Knacksen.
    //
    // Kann das Geraet 48 kHz, faellt beides ersatzlos weg (der Resampler
    // in `OpusStream` bleibt fuer Geraete, die es nicht koennen).
    let supported = device
        .supported_output_configs()
        .ok()
        .and_then(|mut ranges| {
            ranges.find(|r| {
                // Kanalzahl MIT pruefen: die Geraeteliste enthaelt auch
                // Mono-Varianten, und die stand hier zuerst — der Ton lief
                // dadurch einkanalig (gemessen 2026-08-03: "48000 Hz,
                // 1 Kanaele" statt 2). Rate zu treffen und dabei einen
                // Kanal zu verlieren ist kein guter Tausch.
                r.channels() == default_config.channels()
                    && r.sample_format() == default_config.sample_format()
                    && r.min_sample_rate() <= OPUS_SAMPLE_RATE
                    && OPUS_SAMPLE_RATE <= r.max_sample_rate()
            })
        })
        .map(|r| r.with_sample_rate(OPUS_SAMPLE_RATE))
        .unwrap_or(default_config);
    Ok((device, supported.into(), host.id().name()))
}

/// Den Ausgabe-Thread starten: er besitzt den Strom (`cpal::Stream` ist nicht
/// ueberall `Send`) und fuettert ihn, bis `Stop` kommt.
///
/// `latenz_us`: Abstand vom Geraete-Aufruf bis zum Erklingen, wie cpal ihn
/// meldet (`OutputCallbackInfo::timestamp`) — unter ALSA aus der
/// Geraete-Verzoegerung, also samt Uebersetzer-Puffer. Nur fuer die
/// Statistik-Zeile.
pub(super) fn starten(
    device: cpal::Device,
    config: cpal::StreamConfig,
    shared: Arc<Mutex<Shared>>,
    rx: Receiver<AudioCommand>,
    latenz_us: Arc<AtomicU32>,
) -> Result<()> {
    let (sample_rate, channels) = (config.sample_rate, config.channels);
    let cb_shared = Arc::clone(&shared);
    // Eigene Kopie fuer den Fehler-Rueckruf: er lebt so lange wie der Strom,
    // und `shared` wandert gleich in den Thread.
    let fehler_shared = Arc::clone(&shared);
    // Der Stream lebt auf diesem Thread und stirbt mit ihm.
    std::thread::Builder::new()
        .name("pulse-player-audio".into())
        .spawn(move || {
            let stream = device.build_output_stream(
                &config,
                move |out: &mut [f32], info: &cpal::OutputCallbackInfo| {
                    let ts = info.timestamp();
                    if let Some(d) = ts.playback.duration_since(&ts.callback) {
                        latenz_us.store(d.as_micros().min(u32::MAX as u128) as u32, Ordering::Relaxed);
                    }
                    fill_output(&cb_shared, out);
                },
                {
                    move |err| {
                        eprintln!("pulse-player: Audio-Stream: {err}");
                        // NICHT nur melden: der Thread laeuft weiter, und
                        // ohne diesen Zustand bliebe die Anzeige auf
                        // "Ton laeuft" stehen (s. `Shared::geraetefehler`).
                        if let Ok(mut s) = fehler_shared.lock() {
                            s.geraetefehler = true;
                        }
                    }
                },
                None,
            );
            let stream = match stream {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("pulse-player: Ausgabestrom liess sich nicht bauen: {e}");
                    return;
                }
            };
            if let Err(e) = stream.play() {
                eprintln!("pulse-player: Ausgabe startet nicht: {e}");
                return;
            }
            fuettern(&rx, &shared, sample_rate, channels);
        })
        .context("Audio-Thread liess sich nicht starten")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Gegenstueck zu `ausgabe_pipewire::tests`: das echte Standardgeraet ueber
    /// cpal, Stille, und was cpal als Verzoegerung bis zum Lautsprecher meldet.
    /// Nur von Hand (`cargo test --bins -- --ignored echtes_geraet`).
    #[test]
    #[ignore]
    fn echtes_geraet_laeuft_an_und_misst_die_verzoegerung() {
        let (device, config, weg) = oeffnen().expect("Ausgabegeraet");
        let (shared, tx, rx) = super::super::zustand(config.sample_rate, config.channels);
        let latenz = Arc::new(AtomicU32::new(0));
        starten(device, config, Arc::clone(&shared), rx, Arc::clone(&latenz)).expect("Strom");
        std::thread::sleep(Duration::from_millis(600));
        let _ = tx.send(AudioCommand::Stop);
        let us = latenz.load(Ordering::Relaxed);
        eprintln!("{weg}: Verzoegerung {:.1} ms", f64::from(us) / 1000.0);
        assert!(us > 0, "keine Verzoegerung gemeldet");
    }
}
