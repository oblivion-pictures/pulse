//! Der Ton-Sender aller drei Sidecars: Opus, und RED (RFC 2198, [`crate::red`])
//! auf der Strecke zum Server, wenn dessen Antwort `audio/red` annimmt.
//!
//! **Warum eine Opus-Spur, die spaeter getauscht wird, statt einer eigenen
//! `TrackLocal`, die selbst waehlt.** Als Anbieter bindet webrtc-rs in
//! `set_remote_description` jede Spur gegen die ausgehandelten Fassungen
//! (`start_rtp_senders`) und bricht mit dem ersten Fehler ab. Eine RED-Spur
//! an einem alten Server ohne RED liesse also die ganze Verbindung scheitern.
//! Eine Opus-Spur bindet ueberall. Erst danach, wenn die Antwort feststeht,
//! tauscht [`TonSpur::nach_aushandlung`] per `RTCRtpSender::replace_track`
//! auf die RED-Spur: das bindet sie mit DERSELBEN SSRC gegen die
//! ausgehandelten Fassungen und bindet bei einem Fehler die alte Spur zurueck
//! (webrtc 0.17.2, `rtp_transceiver/rtp_sender/mod.rs:380-438`). Ein alter
//! Server sieht damit wortlos dasselbe Opus wie bisher.
//!
//! **Sequenznummer und Zeitstempel fuehren wir selbst**, nicht die Spur:
//! `TrackLocalStaticRTP::write_rtp` setzt je Bindung nur SSRC und
//! Nutzlast-Nummer und laesst beides stehen. So laufen sie ueber den Tausch
//! hinweg weiter, als waere nichts gewesen. Ein Paket je Opus-Rahmen,
//! `marker` gesetzt.
//!
//! **Der Zeitstempel ist Basis + pts** (seit 2026-10-22, gemeinsame Uhr): die
//! Aufnahmezeit des Rahmens in 48-kHz-Takten, ab demselben Nullpunkt wie das
//! Bild. Nur so bildet der Senderbericht beider Spuren dieselbe Aufnahmezeit
//! auf dieselbe Wanduhr ab ([`crate::aufnahmeuhr`]). Vorher war er die SUMME
//! der Rahmendauern; eine Luecke der pts-Zeitlinie (Sprung um die Luecke)
//! landete damit erst ein Paket spaeter in der Marke, und ihr Bezug zum Bild
//! bestand nur ueber die Sendezeit. Ohne pts (Aufrufer ohne Zeitstempel) gilt
//! die Summe weiter.
//!
//! **Bedeutung der Strecke-Zeile „Ton: verloren“ ([`crate::strecke`]).** Der
//! Server packt RED aus, BEVOR sein Empfaengerbericht die Pakete zaehlt
//! (Fork-Patch 0011, im Lesefaden vor `rtpReceiver.ProcessPacket2`). Mit RED
//! zaehlt die Zeile also den Rest, der nach der Rettung aus den Kopien noch
//! fehlt — nicht mehr, was die Leitung verlor.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use bytes::Bytes;
use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::rtp;
use webrtc::rtp::sequence::Sequencer;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use crate::aufnahmeuhr::{Aufnahmeuhr, TON_HZ};
use crate::red::{RedPacker, KOPIEN_MAX};
use crate::sdp::MIME_TYPE_RED;

/// Takt der Opus-Zeitstempel (RFC 7587: immer 48 kHz).
const TAKT_HZ: f64 = TON_HZ as f64;

/// Was die Tonspur nach der Aushandlung sendet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TonArt {
    /// Reines Opus — alter Server, Direktweg oder `kopien = 0`.
    Opus,
    /// RED um Opus; `opus_pt` ist die AUSGEHANDELTE Opus-Nummer, die in
    /// jedem Blockkopf steht.
    Red { kopien: u8, opus_pt: u8 },
}

struct Zustand {
    seq: u16,
    /// Marke bei pts 0 (s. Modulkopf).
    basis: u32,
    /// Marke des naechsten Pakets ohne pts: die letzte plus deren Dauer.
    ts: u32,
    /// Marke des zuletzt gebauten Pakets — eine Marke darf nicht zurueck.
    letzte: Option<u32>,
    aktiv: Arc<TrackLocalStaticRTP>,
    /// `Some` im RED-Betrieb: Packer und Opus-Nummer fuer die Blockkoepfe.
    red: Option<(RedPacker, u8)>,
}

/// Die Tonspur eines Senders; geteilt zwischen Aushandlung und Ton-Faden.
pub struct TonSpur {
    opus: Arc<TrackLocalStaticRTP>,
    zustand: Mutex<Zustand>,
}

impl TonSpur {
    /// Startwerte: die Sequenznummer zufaellig wie bei `TrackLocalStaticSample`,
    /// die Basis aus den Nanosekunden der Uhr statt aus `rand` (das dort
    /// nimmt; hier waere es eine neue Abhaengigkeit). RFC 3550 §5.1 will nur
    /// einen beliebigen Anfang, keinen bestimmten. Die Basis geht an die
    /// Aufnahmeuhr der Verbindung — ohne sie berichtet der Ton nicht.
    pub fn neu(opus: RTCRtpCodecCapability, uhr: &Aufnahmeuhr) -> Self {
        let seq = rtp::sequence::new_random_sequencer().next_sequence_number();
        let basis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u32)
            .unwrap_or_default();
        uhr.ton_basis_setzen(basis);
        Self::mit_start(opus, seq, basis)
    }

    fn mit_start(opus: RTCRtpCodecCapability, seq: u16, basis: u32) -> Self {
        let opus = rtp_spur(opus);
        Self {
            zustand: Mutex::new(Zustand {
                seq,
                basis,
                ts: basis,
                letzte: None,
                aktiv: Arc::clone(&opus),
                red: None,
            }),
            opus,
        }
    }

    /// Die Opus-Spur fuer `pc.add_track` — vor dem Angebot.
    pub fn spur(&self) -> Arc<dyn TrackLocal + Send + Sync> {
        Arc::clone(&self.opus) as Arc<dyn TrackLocal + Send + Sync>
    }

    /// Nach `set_remote_description`: nimmt die Antwort `audio/red` an und ist
    /// `kopien > 0`, wird auf RED getauscht. Scheitert der Tausch, bleibt die
    /// Opus-Spur gebunden (s. Modulkopf), [`Self::senden`] schreibt weiter
    /// Opus, und der Fehler geht an den Aufrufer zum Loggen.
    ///
    /// Vor dem ersten [`Self::senden`] aufzurufen: zwischen dem Tausch und dem
    /// Umstellen des Zustands ginge ein Opus-Paket an die schon geloeste Spur
    /// und damit verloren.
    pub async fn nach_aushandlung(&self, sender: &RTCRtpSender, kopien: u8) -> Result<TonArt> {
        if kopien == 0 {
            return Ok(TonArt::Opus);
        }
        let codecs = sender.get_parameters().await.rtp_parameters.codecs;
        let finde = |mime: &str| {
            codecs
                .iter()
                .find(|c| c.capability.mime_type.eq_ignore_ascii_case(mime))
        };
        let (Some(red), Some(opus)) = (finde(MIME_TYPE_RED), finde(MIME_TYPE_OPUS)) else {
            return Ok(TonArt::Opus);
        };
        let opus_pt = opus.payload_type;
        let kopien = kopien.min(KOPIEN_MAX);
        // Die Fassung aus der Antwort: bindet exakt, auch wenn der Server eine
        // andere fmtp-Zeile nennt als unser Angebot.
        let red_spur = rtp_spur(red.capability.clone());
        sender
            .replace_track(Some(Arc::clone(&red_spur) as Arc<dyn TrackLocal + Send + Sync>))
            .await
            .context("Tonspur auf RED tauschen")?;
        let mut z = self.zustand.lock().unwrap_or_else(|e| e.into_inner());
        z.aktiv = red_spur;
        z.red = Some((RedPacker::neu(kopien), opus_pt));
        Ok(TonArt::Red { kopien, opus_pt })
    }

    /// Ein Opus-Rahmen hinaus. `pts` = Aufnahmezeit in 48-kHz-Takten ab dem
    /// gemeinsamen Nullpunkt mit dem Bild (s. Modulkopf) — so echt, wie der
    /// Sender sie kennt: die Soundkarte taktet mit eigenem Quarz, und gezaehlte
    /// Samples laufen der Wanduhr um ihre Abweichung davon (Bughunt
    /// 2026-10-22). Linux und macOS geben deshalb pts plus Versatz zum
    /// Batch-Anker; Windows den gezaehlten pts, weil es keinen Anker je Chunk
    /// hat (`win-hq-sidecar/src/encode/senke_writer.rs`). `dauer` =
    /// Rahmenlaenge, gebraucht nur ohne `pts`.
    pub async fn senden(&self, opus: &[u8], pts: Option<i64>, dauer: Duration) -> Result<()> {
        let (paket, spur) = self.bauen(opus, pts, dauer);
        spur.write_rtp(&paket).await.context("Tonpaket schreiben")?;
        Ok(())
    }

    /// Der reine Teil von [`Self::senden`] — zaehlt Sequenz und Zeit weiter.
    #[cfg(test)]
    pub(crate) fn paket_bauen(
        &self,
        opus: &[u8],
        pts: Option<i64>,
        dauer: Duration,
    ) -> rtp::packet::Packet {
        self.bauen(opus, pts, dauer).0
    }

    /// Baut unter der Sperre und gibt sie VOR dem Schreiben frei: `write_rtp`
    /// wartet, und ein `std`-Mutex darf nicht ueber ein `await` gehalten werden.
    fn bauen(
        &self,
        opus: &[u8],
        pts: Option<i64>,
        dauer: Duration,
    ) -> (rtp::packet::Packet, Arc<TrackLocalStaticRTP>) {
        let takte = (dauer.as_secs_f64() * TAKT_HZ).round() as u32;
        let mut z = self.zustand.lock().unwrap_or_else(|e| e.into_inner());
        let seq = z.seq;
        let ts = marke(z.basis, z.ts, z.letzte, pts);
        z.seq = seq.wrapping_add(1);
        z.letzte = Some(ts);
        z.ts = ts.wrapping_add(takte);
        let nutzlast = match &mut z.red {
            Some((packer, opus_pt)) => Bytes::from(packer.packen(ts, *opus_pt, opus)),
            None => Bytes::copy_from_slice(opus),
        };
        let paket = rtp::packet::Packet {
            header: rtp::header::Header {
                version: 2,
                // Wie der Opus-Paketierer von `TrackLocalStaticSample`: jedes
                // Paket ist ein ganzer Rahmen.
                marker: true,
                sequence_number: seq,
                timestamp: ts,
                // SSRC und Nutzlast-Nummer setzt `write_rtp` je Bindung.
                ..Default::default()
            },
            payload: nutzlast,
        };
        (paket, Arc::clone(&z.aktiv))
    }
}

/// Die Marke eines Rahmens: Basis + pts, solange sie vorwaerts geht.
///
/// Ohne pts gilt die laufende Summe `naechste` (letzte Marke plus deren
/// Dauer). Springt der pts hinter die letzte Marke zurueck, geht die Marke nur
/// um EINEN Takt weiter, bis Basis + pts sie wieder ueberholt: so findet sie
/// nach wenigen Rahmen auf die Aufnahmezeit zurueck, von der die
/// Senderberichte ausgehen. Mit der vollen Dauer (bis zum Bughunt 2026-10-22)
/// liefe sie dem pts fuer den Rest der Sitzung um den Ruecksprung voraus —
/// ein bleibender Versatz ohne jede Logzeile. Zwei Rahmen mit derselben oder
/// fallender Marke taeten jedem Empfaenger weh.
fn marke(basis: u32, naechste: u32, letzte: Option<u32>, pts: Option<i64>) -> u32 {
    let Some(p) = pts else { return naechste };
    // `as u32` schneidet oben ab wie jede RTP-Uhr (RFC 3550).
    let aus_pts = basis.wrapping_add(p as u32);
    match letzte {
        Some(l) if (aus_pts.wrapping_sub(l) as i32) <= 0 => l.wrapping_add(1),
        _ => aus_pts,
    }
}

/// Eine Aufnahmezeit von `rate` (Abtastrate des Ton-Encoders) in die
/// 48-kHz-Takte der Tonspur — eine Stelle fuer alle drei Sidecars.
pub fn pts_in_takten(pts: i64, rate: u32) -> i64 {
    pts * i64::from(TON_HZ) / i64::from(rate.max(1))
}

/// Beide Spuren (Opus und RED) mit denselben Kennungen.
fn rtp_spur(fassung: RTCRtpCodecCapability) -> Arc<TrackLocalStaticRTP> {
    Arc::new(TrackLocalStaticRTP::new(fassung, "audio".to_owned(), "pulse-hq".to_owned()))
}

#[cfg(test)]
#[path = "ton_tests.rs"]
mod tests;
