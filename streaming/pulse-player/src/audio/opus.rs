//! Opus dekodieren und auf Rate und Kanalzahl des Ausgabegeraets bringen.
//!
//! Abgetrennt von [`super`], weil dort der Ausgabepfad wohnt — Geraet, Ring und
//! Rueckruf — und die Datei mit dem Decoder darin ueber die harte Grenze von
//! 500 Zeilen gewachsen war (`PLAN.md` §12.1).
//!
//! Hier liegt auch die **Nachfuehrung der Abspielrate**
//! ([`OpusDecoder::nachfuehren`]): sie greift am Umrechner an, und der gehoert
//! zu diesem Stueck. Was sie steuert, steht in [`super::uhrenabgleich`].

use anyhow::{anyhow, bail, Context as _, Result};
use ffmpeg_next as ffmpeg;

pub struct OpusDecoder {
    decoder: ffmpeg::decoder::Audio,
    resampler: Option<ffmpeg::software::resampling::Context>,
    out_rate: u32,
    out_channels: u16,
    /// Ob der Decoder einen Verlust per PLC fortsetzt (s. [`Self::verdecken`])
    /// — nur libopus.
    plc: bool,
}

impl OpusDecoder {
    pub fn new(out_rate: u32, out_channels: u16) -> Result<Self> {
        Self::mit(&["libopus", "opus"], out_rate, out_channels)
    }

    /// Den ersten vorhandenen Decoder aus `namen` oeffnen. Eigener Eingang,
    /// damit die Tests beide Decoder gezielt pruefen koennen (`verdeckung`).
    pub fn mit(namen: &[&str], out_rate: u32, out_channels: u16) -> Result<Self> {
        ffmpeg::init().ok();
        let codec = namen
            .iter()
            .find_map(|n| ffmpeg::decoder::find_by_name(n))
            .ok_or_else(|| anyhow!("kein Opus-Decoder in diesem FFmpeg-Build"))?;
        let plc = codec.name() == "libopus";

        let mut context = ffmpeg::codec::context::Context::new_with_codec(codec);
        // Opus ueber RTP ist immer 48 kHz; die Kanalzahl steht im TOC-Byte, der
        // Decoder braucht aber eine gesetzte Ausgangs-Konfiguration. ffmpeg-next
        // hat dafuer keinen sicheren Setter — deshalb direkt am Kontext.
        unsafe {
            let ptr = context.as_mut_ptr();
            (*ptr).sample_rate = 48_000;
            ffmpeg::ffi::av_channel_layout_default(&raw mut (*ptr).ch_layout, 2);
        }
        let decoder = context.decoder().audio().context("Opus-Decoder oeffnen")?;

        Ok(Self { decoder, resampler: None, out_rate, out_channels, plc })
    }

    /// Dekodiert ein Opus-Paket und liefert verschraenkte f32-Samples in der
    /// Rate und Kanalzahl des Ausgabegeraets.
    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<f32>> {
        let pkt = ffmpeg::codec::packet::Packet::copy(packet);
        if let Err(e) = self.decoder.send_packet(&pkt) {
            // Ein kaputtes Paket nach einer Luecke darf den Ton nicht beenden.
            eprintln!("pulse-player: Opus send_packet: {e}");
            return Ok(Vec::new());
        }

        let mut out = Vec::new();
        let mut frame = ffmpeg::util::frame::audio::Audio::empty();
        while self.decoder.receive_frame(&mut frame).is_ok() {
            let converted = self.resample_for_device(&frame)?;
            out.extend_from_slice(&converted);
        }
        Ok(out)
    }

    /// Ersatzton fuer einen verlorenen Rahmen: `toc` = erstes Byte des zuletzt
    /// dekodierten Pakets. `None`, wenn der Decoder nichts liefert — dann
    /// fuellt `verdeckung` Stille auf.
    ///
    /// **Der Weg dorthin**: FFmpeg reicht keine Verlustmeldung an den Decoder
    /// durch (ein leeres Paket heisst bei `avcodec_send_packet` „Ende des
    /// Stroms"). Gegeben wird deshalb ein Paket aus NUR dem TOC-Byte (Code 0,
    /// ein Rahmen der Laenge null) — fuer Opus ein gueltiges Paket ohne
    /// Rahmendaten. Gemessen am 2026-10-15 (FFmpeg 8.1 des Pruefbaus, Test
    /// `verdeckung::tests::decoder_verdeckt_ueber_das_toc_paket`): libopus
    /// liefert einen Rahmen der im TOC genannten Dauer, der das Signal
    /// fortsetzt und ueber einige Rahmen abklingt (PLC). FFmpegs eigener
    /// Decoder `opus` klingt im ersten Ersatzrahmen aus und gibt danach
    /// Stille. Beide steigen beim naechsten echten Paket ohne Sprung wieder ein
    /// — der Decoder weiss ja, dass ein Rahmen fehlte. Genutzt wird es fuer
    /// beide; PLC im eigentlichen Sinn ist es nur bei libopus ([`Self::mit_plc`]).
    pub fn verdecken(&mut self, toc: u8) -> Option<Vec<f32>> {
        self.decode(&[toc & 0xFC]).ok().filter(|pcm| !pcm.is_empty())
    }

    /// Ob [`Self::verdecken`] das Signal fortsetzt (libopus) oder nur
    /// ausblendet (FFmpegs eigener Decoder).
    pub fn mit_plc(&self) -> bool {
        self.plc
    }

    /// Fuer die Startmeldung: welcher Decoder, und was er aus einem Verlust
    /// macht (s. [`Self::verdecken`]).
    pub fn verdeckungsart(&self) -> &'static str {
        if self.plc {
            "libopus — Verluste per PLC verdeckt"
        } else {
            "opus (FFmpeg) — Verluste ausgeblendet, kein PLC"
        }
    }

    /// Die Abspielrate nachfuehren: ueber die naechsten `distanz` Ausgabe-Frames
    /// sollen `delta` Frames mehr (positiv) oder weniger (negativ) entstehen.
    ///
    /// Liefert `false`, wenn es nicht angenommen wurde — dann steht entweder
    /// noch kein Umrechner (vor dem ersten Paket) oder FFmpeg hat ihn
    /// wegoptimiert. Der Aufrufer meldet das EINMAL und laesst es dann; ein
    /// stiller Ausfall der Regelung waere genau die Sorte Fehler, die hier
    /// behoben wurde.
    pub fn nachfuehren(&mut self, delta: i32, distanz: i32) -> bool {
        let Some(resampler) = self.resampler.as_mut() else { return false };
        // Kein sicherer Weg in ffmpeg-next; der Zeiger ist gueltig, solange der
        // Umrechner lebt, und wir halten ihn hier exklusiv.
        let rc = unsafe { ffmpeg::ffi::swr_set_compensation(resampler.as_mut_ptr(), delta, distanz) };
        rc >= 0
    }

    fn resample_for_device(&mut self, frame: &ffmpeg::util::frame::audio::Audio) -> Result<Vec<f32>> {
        use ffmpeg::util::format::sample::{Sample, Type};

        let target_layout =
            ffmpeg::util::channel_layout::ChannelLayout::default(self.out_channels.into());
        let target_format = Sample::F32(Type::Packed);

        if self.resampler.is_none() {
            // **`flags=res` ist Pflicht, nicht Kosmetik.** Opus liefert 48 kHz,
            // und das Geraet laeuft hier ebenfalls auf 48 kHz — ohne diese
            // Option legt FFmpeg dann gar keinen Neuabtaster an, sondern
            // reicht die Samples durch. `swr_set_compensation` haette nichts,
            // woran es drehen koennte, und die Uhren-Nachfuehrung
            // (`uhrenabgleich`) waere wirkungslos, ohne dass es auffiele.
            // Belegt im Optionssatz von libswresample: `res` = „force
            // resampling".
            let mut optionen = ffmpeg::Dictionary::new();
            optionen.set("flags", "res");
            self.resampler = Some(
                ffmpeg::software::resampling::Context::get_with(
                    frame.format(),
                    frame.channel_layout(),
                    frame.rate(),
                    target_format,
                    target_layout,
                    self.out_rate,
                    optionen,
                )
                .context("Resampler")?,
            );
        }
        let resampler = self.resampler.as_mut().expect("gerade gesetzt");

        let mut converted = ffmpeg::util::frame::audio::Audio::empty();
        resampler.run(frame, &mut converted).context("Resampling")?;

        // NICHT `plane::<f32>(0)` benutzen: das liefert eine Slice der Laenge
        // `samples()` — also nur die FRAME-Anzahl, ohne Kanalfaktor (belegt in
        // ffmpeg-next `util/frame/audio.rs`, `from_raw_parts(.., self.samples())`).
        // Bei verschraenktem Stereo liegen dort aber `samples * 2` Werte. Der
        // frueher hier gerechnete Index `samples() * channels` lief damit ueber
        // das Slice-Ende und riss den Audio-Thread mit einem Panic weg — bei
        // jedem Geraet ausser Mono, also praktisch immer.
        //
        // `data(0)` traegt die echte Puffergroesse (`linesize[0]`).
        let frames = converted.samples();
        let wanted = frames * self.out_channels as usize;
        let bytes = converted.data(0);
        let needed = wanted * std::mem::size_of::<f32>();
        if bytes.len() < needed {
            bail!("Audio-Ebene zu kurz: {} < {needed} Bytes", bytes.len());
        }
        // FFmpegs `AV_SAMPLE_FMT_FLT` ist in der Bytereihenfolge der Maschine.
        Ok(bytes[..needed]
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|c| f32::from_ne_bytes([c[0], c[1], c[2], c[3]]))
            .collect())
    }
}
