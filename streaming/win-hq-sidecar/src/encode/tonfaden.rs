//! Der Ton auf eigenem Faden — nur auf dem Sendeweg ohne Container (WHIP,
//! Direktweg).
//!
//! **Warum.** Bis hierher holte der Taktfaden den Ton einmal je Durchlauf ab,
//! NACH dem Warten auf den nächsten Bildplatz (`pipeline_hw::run`). Jeder
//! Tonrahmen wartete damit bis zu einem Bildabstand plus die Arbeitszeit des
//! Durchlaufs, bevor er kodiert wurde — und diese Arbeitszeit wächst mit allem,
//! was das Bild teurer macht (10 bit, Skalierung, ein zäher Encoder). Kein
//! Zuschauer kennt die Aufnahmezeit des Tons: MediaMTX stempelt Opus nach
//! Paketzahl neu und verankert jede Spur an ihrer eigenen Ankunft (Plan
//! `intern/docs/plans/2026-10-16-bild-ton-sync-plan.md`, B3/B4). Jede
//! Millisekunde, die der Ton hier länger liegt als das Bild, klingt beim
//! Zuschauer zu spät. Ob das der Grund für den 10-bit-Versatz ist, zeigt die
//! Messzeile `[sync]` (`senke_writer`) — vorher/nachher über
//! `PULSE_HQ_TON_IM_TAKT=1`.
//!
//! **Warum nicht auch auf dem Muxer-Weg.** FLV ist EINE Zeitleiste: der Muxer
//! gibt ein Bild erst frei, wenn Ton mit passendem Zeitstempel vorliegt
//! (`audio::OPUS_FRAME_MS`). Dort hilft ein früher kodierter Ton nicht, und
//! zwei Erzeuger an einem `AVFormatContext` gingen ohnehin nicht. Der eigene
//! Sendeweg hat zwei unabhängige Spuren; dafür gibt es ihn.
//!
//! **Was der Faden NIE tut: den Aufnahmekanal oder den Encoder freigeben.**
//! Ein fallengelassener Empfänger beendet den WASAPI-Faden
//! (`audio::wasapi::send_or_stop` → Disconnected), und der gibt dabei den
//! Audio-Client frei — genau der Abbau, den `pipeline_hw::run` wegen des
//! Treiber-Timers nach Stream-Ende vermeidet (`0xC0000005`, Kopf dort). Beides
//! wird am Ende vergessen, nicht fallengelassen; der Prozess endet ohnehin
//! direkt nach dem Stopp.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{Result, anyhow};
use serde_json::json;

use super::audio::AudioPipeline;
use super::senke_writer::TonAusgang;
use crate::audio::CapturedAudio;

/// Was der Encoder für den Ton-Faden abgibt: die Ton-Pipeline samt ihrem
/// Ausgang in die Warteschlange des Sendewegs.
pub struct TonAbzweig {
    pub(super) audio: AudioPipeline,
    pub(super) ausgang: TonAusgang,
}

// SAFETY: `AudioPipeline` hält den libopus-Kontext und ist deshalb nicht
// `Send` (ffmpeg-next markiert konservativ). Sie entsteht auf dem Taktfaden,
// geht per *move* an genau einen Faden und wird nur dort benutzt; der Encoder
// behält keine Referenz (`FfmpegHwEncoder::ton_abzweigen` nimmt sie heraus).
unsafe impl Send for TonAbzweig {}

/// Wie lange der Faden höchstens auf Ton wartet, bevor er nach dem
/// Stopp-Merker sieht. Kurz genug, dass `anhalten` nicht spürbar hängt.
const STOPP_BLICK: Duration = Duration::from_millis(50);

pub struct TonFaden {
    stopp: Arc<AtomicBool>,
    fehler: Arc<Mutex<Option<String>>>,
    faden: Option<JoinHandle<()>>,
}

impl TonFaden {
    /// Startet den Faden. `samples` ist der Empfänger der WASAPI-Aufnahme;
    /// der Ursprung der Ton-Zeitleiste muss vorher gesetzt sein
    /// (`set_audio_origin`).
    pub fn starten(abzweig: TonAbzweig, samples: Receiver<CapturedAudio>) -> Result<Self> {
        let stopp = Arc::new(AtomicBool::new(false));
        let fehler = Arc::new(Mutex::new(None));
        let (stopp_f, fehler_f) = (Arc::clone(&stopp), Arc::clone(&fehler));
        let faden = thread::Builder::new()
            .name("ton-encode".into())
            .spawn(move || schleife(abzweig, samples, &stopp_f, &fehler_f))
            .map_err(|e| anyhow!("ton-encode-Faden starten: {e}"))?;
        eprintln!("[ton] Ton auf eigenem Faden (nicht im Bildtakt)");
        Ok(Self { stopp, fehler, faden: Some(faden) })
    }

    /// Ist der Ton gescheitert? Der Taktfaden fragt je Durchlauf und bricht
    /// den Stream mit diesem Grund ab — ein Tonfehler wird nicht verschluckt,
    /// genau wie vorher im Takt.
    pub fn fehler(&self) -> Option<anyhow::Error> {
        let grund = self.fehler.lock().ok()?.clone()?;
        Some(anyhow!("Ton: {grund}"))
    }

    /// Faden beenden und abwarten. MUSS vor `finish()` des Encoders laufen:
    /// solange der Faden seinen Ausgang hält, endet der Abgabe-Faden nicht.
    pub fn anhalten(&mut self) {
        self.stopp.store(true, Ordering::Relaxed);
        if let Some(f) = self.faden.take() {
            let _ = f.join();
        }
    }
}

fn schleife(
    abzweig: TonAbzweig,
    samples: Receiver<CapturedAudio>,
    stopp: &AtomicBool,
    fehler: &Mutex<Option<String>>,
) {
    let TonAbzweig { mut audio, ausgang } = abzweig;
    let ergebnis = (|| -> Result<()> {
        while !stopp.load(Ordering::Relaxed) {
            match samples.recv_timeout(STOPP_BLICK) {
                Ok(chunk) => {
                    for paket in audio.send(&chunk)? {
                        ausgang.audio(paket)?;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                // WASAPI-Faden gestorben (Gerät weg): ohne Ton weiter, aber
                // EINMAL sichtbar — dieselbe Meldung wie vorher im Takt.
                Err(RecvTimeoutError::Disconnected) => {
                    eprintln!("[ton] audio capture beendet — Stream läuft ohne Ton weiter");
                    crate::events::emit(json!({"ev": "log", "line": "Audio-Aufnahme abgebrochen (Gerät entfernt?) — Stream läuft ohne Ton weiter"}));
                    return Ok(());
                }
            }
        }
        // Regulärer Stopp: den Rest aus libopus noch abgeben, wie vorher
        // `FfmpegHwEncoder::finish`.
        for paket in audio.flush()? {
            ausgang.audio(paket)?;
        }
        Ok(())
    })();
    if let Err(e) = ergebnis {
        eprintln!("[ton] gescheitert: {e:#}");
        if let Ok(mut slot) = fehler.lock() {
            *slot = Some(format!("{e:#}"));
        }
    }
    // Vergessen statt fallenlassen — Begründung im Modulkopf. Der Ausgang
    // dagegen MUSS fallen, sonst wartet der Abgabe-Faden ewig auf ihn.
    std::mem::forget(samples);
    std::mem::forget(audio);
    drop(ausgang);
}

/// Den Ton-Faden einrichten, wenn der Encode-Weg es kann — sonst `None`, und
/// der Takt kodiert den Ton weiter selbst. `PULSE_HQ_TON_IM_TAKT=1` erzwingt
/// den alten Weg, damit sich vorher/nachher am selben Rechner messen lässt.
///
/// Der Aufnahmekanal wird aus `capture` HERAUSgenommen und durch einen toten
/// ersetzt; der Takt darf danach nicht mehr daran ziehen (er sähe
/// „Disconnected" und meldete ein totes Gerät).
pub fn abzweigen(
    encoder: &mut dyn super::bildencoder::BildEncoder,
    capture: &mut Option<crate::audio::AudioCapture>,
) -> Result<Option<TonFaden>> {
    if crate::env::flag("PULSE_HQ_TON_IM_TAKT") {
        eprintln!("[ton] PULSE_HQ_TON_IM_TAKT=1 — Ton bleibt im Bildtakt");
        return Ok(None);
    }
    let Some(ac) = capture.as_mut() else { return Ok(None) };
    let Some(abzweig) = encoder.ton_abzweigen() else { return Ok(None) };
    let samples = std::mem::replace(&mut ac.samples, std::sync::mpsc::channel().1);
    TonFaden::starten(abzweig, samples).map(Some)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    use super::*;
    use crate::encode::senke::PaketSenke;
    use crate::encode::senke_writer::SenkenWriter;

    struct Zaehler(Arc<AtomicUsize>);
    impl PaketSenke for Zaehler {
        fn video(&mut self, _d: &[u8], _pts: Option<i64>) -> Result<()> {
            Ok(())
        }
        fn audio(&mut self, _d: &[u8], _dauer: Duration) -> Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn schliesse(&mut self) {}
    }

    /// Die Gefahr dieses Fadens ist ein HÄNGENDES Stream-Ende: hält er
    /// seinen Ausgang noch, wartet `finish` ewig. Nach `anhalten` muss
    /// `finish` zurückkehren, und der Ton muss angekommen sein.
    #[test]
    fn nach_anhalten_endet_der_abgabe_faden_und_der_ton_kam_an() {
        let ton = Arc::new(AtomicUsize::new(0));
        let mut writer =
            SenkenWriter::start(Box::new(Zaehler(Arc::clone(&ton))), Duration::from_millis(10), 48_000)
                .unwrap();
        let audio = AudioPipeline::create(None, 48_000, 2, 128, 0).unwrap();
        let abzweig = TonAbzweig { audio, ausgang: writer.ton_ausgang().unwrap() };
        let (tx, rx) = std::sync::mpsc::channel();
        let mut faden = TonFaden::starten(abzweig, rx).unwrap();
        let frames = 48 * super::super::audio::opus_frame_ms();
        for _ in 0..5 {
            tx.send(CapturedAudio {
                format: crate::audio::AudioFormat { sample_rate: 48_000, channels: 2, bits_per_sample: 32 },
                bytes: vec![0u8; frames * 8],
                frames: frames as u32,
                captured_at: Instant::now(),
                qpc: 0,
            })
            .unwrap();
        }
        std::thread::sleep(Duration::from_millis(200));
        faden.anhalten();
        writer.finish().unwrap();
        assert!(ton.load(Ordering::SeqCst) >= 2, "Tonpakete müssen den Sendeweg erreichen");
        assert!(faden.fehler().is_none());
    }
}
