//! Tonausgabe unter Linux direkt ueber PipeWire.
//!
//! **Warum nicht mehr nur cpal.** cpal spricht unter Linux ALSA; im Flatpak
//! landet das ueber das ALSA-Pulse-Plugin beim PulseAudio-Ersatz von PipeWire
//! und erst dann im Graphen. Am 2026-10-22 an der laufenden Sitzung
//! ausgelesen: der Uebersetzer hielt allein 32 ms Ton zurueck
//! (`pulse.attr.tlength` 12288 Byte bei F32-Stereo — cpal laesst die
//! Puffergroesse offen, und das Plugin waehlt grosszuegig), dazu ein Takt des
//! Graphen und der Vorrat der Soundkarte, gerechnet zusammen rund 50-60 ms.
//! Die Lippen-Regelung sieht davon nichts und kann den Ton ohnehin nur um
//! 20 ms vorziehen (`ringregelung::RING_BODEN_MS`). Hier bestimmt der Player
//! den Takt selbst ([`QUANTUM_VORGABE`]), und der Uebersetzer faellt weg.
//!
//! **Aufbau.** Ein eigener Faden faehrt die PipeWire-Hauptschleife; der
//! Abruf (`process`) laeuft im Echtzeitfaden des Graphen (`RT_PROCESS`) und
//! ruft dasselbe [`super::fill_output`] wie der cpal-Weg. Ring, Regelung und
//! Zaehler bleiben unberuehrt. Gefuettert wird weiter vom Befehlsfaden
//! (`super::fuettern`), der beim Ende den [`Griff`] fallen laesst und damit
//! diesen Faden beendet.
//!
//! **Rueckfall.** Kommt der Strom nicht binnen [`ANLAUF`] in Gang (kein
//! PipeWire, kein Zugriff aus dem Flatpak, Aushandlung gescheitert, kein
//! Geraet verbunden), meldet
//! [`starten`] einen Fehler, und `AudioOutput::new` nimmt den cpal-Weg.
//! `PULSE_PLAYER_TON=alsa` erzwingt ihn — fuer den Vergleich und als
//! Notausgang, falls dieser Weg auf einem Rechner Aerger macht.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use pw::stream::StreamState;
use spa::param::audio::{AudioFormat, AudioInfoRaw};
use spa::pod::Pod;

use super::{fill_output, Shared, OPUS_SAMPLE_RATE};

/// Immer Stereo: Opus liefert es so, und auf die Lautsprecher verteilt der
/// Graph (auch auf Mehrkanal- oder Mono-Geraete).
pub(super) const KANAELE: u16 = 2;

/// Takt des Abrufs in Samples bei 48 kHz: 256 = 5,3 ms. PipeWire faehrt den
/// Graphen mit dem kleinsten angeforderten Takt, also kann diese Zahl auch die
/// Ausgabe anderer Programme feiner takten — 5 ms sind fuer PipeWire normal
/// (Vorgabe-Untergrenze 32). Nachstellbar ueber `PULSE_PLAYER_PW_QUANTUM`
/// (32 bis 2048), wie `PULSE_AUDIO_QUANTUM` beim Linux-Sidecar.
const QUANTUM_VORGABE: u32 = 256;

/// So lange darf der Strom brauchen, bis er laeuft (`Streaming`).
const ANLAUF: Duration = Duration::from_secs(3);

/// Hoechstens so viele Frames je Abruf, fuer den vorab angelegten
/// Zwischenpuffer (der Abruf darf nicht allokieren). Mehr als der groesste
/// Takt, den PipeWire faehrt (`clock.quantum-limit`, Vorgabe 8192).
const MAX_FRAMES: usize = 8192;

/// Ob dieser Weg versucht werden soll (`PULSE_PLAYER_TON=alsa` = nein).
pub(super) fn gewuenscht() -> bool {
    !std::env::var("PULSE_PLAYER_TON").is_ok_and(|v| v.eq_ignore_ascii_case("alsa"))
}

fn quantum() -> u32 {
    std::env::var("PULSE_PLAYER_PW_QUANTUM")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|n| (32..=2048).contains(n))
        .unwrap_or(QUANTUM_VORGABE)
}

/// Laufende PipeWire-Ausgabe. Fallenlassen beendet die Hauptschleife und
/// wartet auf ihren Faden.
pub(super) struct Griff {
    stop: pw::channel::Sender<()>,
    faden: Option<JoinHandle<()>>,
}

impl Drop for Griff {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(f) = self.faden.take() {
            let _ = f.join();
        }
    }
}

/// Strom anlegen und warten, bis er laeuft. `latenz_us` bekommt je
/// Abruf die Verzoegerung bis zum Lautsprecher (`pw_stream_get_time_n`).
pub(super) fn starten(shared: Arc<Mutex<Shared>>, latenz_us: Arc<AtomicU32>) -> Result<Griff> {
    let (bereit_tx, bereit_rx) = sync_channel::<Result<(), String>>(1);
    let (stop, stop_rx) = pw::channel::channel::<()>();
    let quantum = quantum();
    let faden = std::thread::Builder::new()
        .name("pulse-player-pipewire".into())
        .spawn(move || {
            if let Err(e) = hauptschleife(shared, latenz_us, quantum, &bereit_tx, stop_rx) {
                // Vor dem Anlauf: der Aufrufer wartet auf genau diese Meldung.
                // Danach: niemand wartet mehr, dann bleibt die Logzeile.
                if bereit_tx.try_send(Err(format!("{e:#}"))).is_err() {
                    eprintln!("pulse-player: PipeWire-Ausgabe beendet: {e:#}");
                }
            }
        })
        .context("PipeWire-Faden liess sich nicht starten")?;
    let griff = Griff { stop, faden: Some(faden) };
    match bereit_rx.recv_timeout(ANLAUF) {
        Ok(Ok(())) => {
            eprintln!(
                "pulse-player: Tonausgabe direkt ueber PipeWire, Takt {quantum} Samples \
                 ({:.1} ms)",
                f64::from(quantum) * 1000.0 / f64::from(OPUS_SAMPLE_RATE)
            );
            Ok(griff)
        }
        // `griff` faellt hier und beendet den Faden.
        Ok(Err(e)) => Err(anyhow!(e)),
        Err(_) => Err(anyhow!("Strom laeuft nach {} s noch nicht", ANLAUF.as_secs())),
    }
}

/// Zustand des Abrufs im Echtzeitfaden.
struct Abruf {
    shared: Arc<Mutex<Shared>>,
    latenz_us: Arc<AtomicU32>,
    /// Vorab angelegt: der Abruf darf nicht allokieren.
    zwischen: Vec<f32>,
    /// Meldet den Anlauf genau einmal (bereit oder gescheitert).
    bereit: Option<SyncSender<Result<(), String>>>,
}

fn hauptschleife(
    shared: Arc<Mutex<Shared>>,
    latenz_us: Arc<AtomicU32>,
    quantum: u32,
    bereit: &SyncSender<Result<(), String>>,
    stop_rx: pw::channel::Receiver<()>,
) -> Result<()> {
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None)?;
    let _stop = stop_rx.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        move |_| mainloop.quit()
    });
    let context = pw::context::ContextRc::new(&mainloop, None)?;
    let core = context.connect_rc(None).context("keine Verbindung zu PipeWire")?;

    let props = properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Playback",
        *pw::keys::MEDIA_ROLE => "Movie",
        *pw::keys::APP_NAME => "Pulse",
        *pw::keys::NODE_NAME => "pulse-player",
        *pw::keys::NODE_DESCRIPTION => "Pulse Stream",
        *pw::keys::NODE_LATENCY => format!("{quantum}/{OPUS_SAMPLE_RATE}"),
    };
    let stream = pw::stream::StreamRc::new(core, "pulse-player", props)?;
    let fehler_shared = Arc::clone(&shared);
    let abruf = Abruf {
        shared,
        latenz_us,
        zwischen: vec![0.0; MAX_FRAMES * usize::from(KANAELE)],
        bereit: Some(bereit.clone()),
    };
    let _listener = stream
        .add_local_listener_with_user_data(abruf)
        .state_changed(move |_s, ab, _alt, neu| match neu {
            // Erst `Streaming` zaehlt, nicht schon `Paused` (ausgehandelt):
            // ein Strom ohne Verbindung zu einem Geraet bliebe sonst stumm,
            // ohne dass der cpal-Rueckfall greift.
            StreamState::Streaming => {
                if let Some(tx) = ab.bereit.take() {
                    let _ = tx.try_send(Ok(()));
                }
            }
            StreamState::Error(grund) => {
                if let Some(tx) = ab.bereit.take() {
                    let _ = tx.try_send(Err(format!("Strom-Fehler: {grund}")));
                } else {
                    // Mitten im Lauf: wie der Fehler-Rueckruf von cpal — der
                    // Zustand muss sichtbar werden (s. `Shared::geraetefehler`).
                    eprintln!("pulse-player: PipeWire-Ausgabe: {grund}");
                    if let Ok(mut s) = fehler_shared.lock() {
                        s.geraetefehler = true;
                    }
                }
            }
            _ => {}
        })
        .process(abrufen)
        .register()?;

    let mut format = AudioInfoRaw::new();
    format.set_format(AudioFormat::F32LE);
    format.set_rate(OPUS_SAMPLE_RATE);
    format.set_channels(u32::from(KANAELE));
    // Ohne Positionen haelt der Graph die Kanaele fuer AUX0/AUX1 und verteilt
    // sie nicht als links/rechts.
    let mut position = [0u32; spa::sys::SPA_AUDIO_MAX_CHANNELS as usize];
    position[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
    position[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
    format.set_position(position);
    let objekt = spa::pod::Object {
        type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: spa::param::ParamType::EnumFormat.as_raw(),
        properties: format.into(),
    };
    let bytes: Vec<u8> = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(objekt),
    )
    .map_err(|e| anyhow!("Format nicht serialisierbar: {e:?}"))?
    .0
    .into_inner();
    let mut params = [Pod::from_bytes(&bytes).ok_or_else(|| anyhow!("Format-Pod ungueltig"))?];
    stream.connect(
        spa::utils::Direction::Output,
        None,
        pw::stream::StreamFlags::AUTOCONNECT
            | pw::stream::StreamFlags::MAP_BUFFERS
            | pw::stream::StreamFlags::RT_PROCESS,
        &mut params,
    )?;
    mainloop.run();
    Ok(())
}

/// Ein Abruf des Graphen: so viele Frames wie verlangt aus dem Ring holen.
/// Echtzeit — keine Allokation, keine Ausgabe, nur die eine Sperre in
/// `fill_output`.
fn abrufen(stream: &pw::stream::Stream, ab: &mut Abruf) {
    let Some(mut puffer) = stream.dequeue_buffer() else { return };
    let verlangt = puffer.requested() as usize;
    let datas = puffer.datas_mut();
    let Some(data) = datas.first_mut() else { return };
    let kanaele = usize::from(KANAELE);
    let stride = std::mem::size_of::<f32>() * kanaele;
    let Some(bytes) = data.data() else { return };
    let mut frames = (bytes.len() / stride).min(MAX_FRAMES);
    if verlangt > 0 {
        frames = frames.min(verlangt);
    }
    let laenge = frames * stride;
    let zwischen = &mut ab.zwischen[..frames * kanaele];
    fill_output(&ab.shared, zwischen);
    for (ziel, wert) in bytes[..laenge].chunks_exact_mut(4).zip(zwischen.iter()) {
        ziel.copy_from_slice(&wert.to_le_bytes());
    }
    let chunk = data.chunk_mut();
    *chunk.offset_mut() = 0;
    *chunk.stride_mut() = stride as i32;
    *chunk.size_mut() = laenge as u32;
    // Verzoegerung bis zum Lautsprecher: `delay` in Takten der Graphenrate,
    // dazu, was im eigenen Strom noch vor dem Graphen liegt (`buffered`, in
    // Samples bei unserer Rate).
    if let Ok(zeit) = stream.time() {
        let rate = zeit.rate();
        if rate.denom > 0 {
            let graph_s = zeit.delay().max(0) as f64 * f64::from(rate.num) / f64::from(rate.denom);
            let strom_s = zeit.buffered() as f64 / f64::from(OPUS_SAMPLE_RATE);
            let us = ((graph_s + strom_s) * 1e6) as u32;
            ab.latenz_us.store(us.max(1), Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gegen das echte PipeWire dieses Rechners: der Strom handelt sich aus,
    /// der Graph ruft ab, und die Verzoegerung bis zum Lautsprecher kommt an.
    /// Nur von Hand (`cargo test --bins -- --ignored echter_strom`), weil er
    /// einen laufenden PipeWire-Dienst braucht. Der Ring bleibt leer, es
    /// klingt also nur Stille.
    #[test]
    #[ignore]
    fn echter_strom_laeuft_an_und_misst_die_verzoegerung() {
        let (shared, _tx, _rx) = super::super::zustand(OPUS_SAMPLE_RATE, KANAELE);
        let latenz = Arc::new(AtomicU32::new(0));
        let griff = starten(Arc::clone(&shared), Arc::clone(&latenz)).expect("PipeWire-Strom");
        std::thread::sleep(Duration::from_millis(600));
        let abgerufen = shared.lock().unwrap().ausgabe;
        drop(griff);
        let ms = abgerufen as f64 / (f64::from(OPUS_SAMPLE_RATE) * f64::from(KANAELE)) * 1000.0;
        let us = latenz.load(Ordering::Relaxed);
        eprintln!("abgerufen {ms:.0} ms in 600 ms, Verzoegerung {:.1} ms", f64::from(us) / 1000.0);
        assert!(ms > 300.0, "der Graph ruft nicht ab: {ms:.0} ms");
        assert!(us > 0, "keine Verzoegerung gemeldet");
    }
}
