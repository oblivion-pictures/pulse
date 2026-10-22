//! Die Bildspur des Direktpfad-Senders: Auftrags-Konfiguration, Paketierer-
//! Wahl und Takt-Rechnung.
//!
//! **Warum getrennt vom Sender** ([`super`]): das sind die RECHNUNGEN und
//! Behälter — der Sender selbst ist Lebensdauer, Aushandlung und PC. Die
//! Stücke hier sind die, die der WHIP-Sender der Sidecars seit je
//! mitführt (`Bildspur` dort); sie stehen hier einmal statt ein zweites Mal
//! je Weg. (Die Ton-Rechnung rundet inzwischen selbst, in `ton.rs`.)

use std::sync::{Arc, Mutex};

use webrtc::rtp::codecs::h264::H264Payloader;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;

use crate::av1::SpurZustand;
use crate::pacer;

/// Wie ein encodiertes Bild in RTP-Nutzlasten zerfaellt. Derselbe Schnitt wie
/// im WHIP-Sender: eigene AV1-/HEVC-Paketierer, webrtc-rs' H.264-Zerleger.
pub(super) enum Paketierer {
    Av1,
    H264(H264Payloader),
    /// VPS/SPS/PPS-Puffer des eigenen HEVC-Paketierers (`crate::hevc`) —
    /// dieselbe Zustaendigkeit wie SPS/PPS im H264Payloader, unter dem Spur-Lock.
    Hevc(Vec<Vec<u8>>),
}

/// Soll gegen Ist des Taktgebers ins Protokoll — Form und Begruendung im
/// WHIP-Sender (`melde_verteilung` dort). Nur das Etikett unterscheidet sich.
pub(super) fn melde_verteilung(soll_ms: f64, ist_ms: f64, pakete: usize) {
    eprintln!(
        "[direct] Verteilung je Bild: soll {soll_ms:.2} ms, ist {ist_ms:.2} ms ({pakete} Pakete)"
    );
}

/// Stau-Deckel des Taktgebers: Bild verworfen. Anders als bei den WHIP-
/// Sendern wird hier KEIN Vollbild angestossen — der Direktpfad hat seinen
/// Vollbild-Weg im RTCP-Rueckkanal des Aufrufers, und der Zuschauer selbst
/// reagiert auf die Sequenzluecke, die der Verwurf reisst: sein PLI kommt
/// ueber `rueckkanal` zurueck und fordert das Vollbild an. Nur melden.
pub(super) fn melde_verwurf() {
    eprintln!("[direct] Sendestau: Bild verworfen");
}

/// Was der Aufbau über den Strom wissen muss. Die Maße sind die des ANGEBOTS
/// (fmtp-Stufe), nicht die der Aufnahme — die steht beim Aushandeln noch
/// nicht fest; eine zu HOCH angesetzte H.264-Stufe ist folgenlos, eine zu
/// niedrige die dokumentierte Fehlerklasse (`crate::sdp::codec_capability`).
#[derive(Debug, Clone)]
pub struct Konfig {
    /// Codec-Kurzname wie im `start`-Request — `"h264"`, `"hevc"` oder
    /// `"av1"`.
    pub codec_slug: &'static str,
    pub fps: u32,
    pub breite: u32,
    pub hoehe: u32,
    /// Ziel-Bitrate — Maßstab für die REMB-Einordnung beim Aufrufer.
    pub bitrate_kbps: u32,
    /// Encodiert der Strom mit 10 bit? Geht wie im WHIP-Sender in die
    /// HEVC-Fähigkeit (`crate::sdp::codec_capability`: Main 10,
    /// `profile-id=2`, sonst Main). Der Aufrufer muss den Wert kennen, BEVOR
    /// der Encoder läuft: ausgehandelt wird vor dem ersten Bild.
    ///
    /// **Auf der Leitung ändert das heute nichts** (H.264 und AV1 lesen den
    /// Wert ohnehin nicht, es geht nur um HEVC) — am 2026-10-14 im Test
    /// `sdp::angebot_tests::hevc_main10_passt_zum_angebot_des_players`
    /// nachgesehen: der Direktweg ANTWORTET, und webrtc-rs übernimmt in die
    /// Antwort die fmtp-Zeile des Angebots. Der Player bietet HEVC ohne eine
    /// an, die Antwort nennt also gar kein Profil, weder für 8 noch für 10 bit;
    /// der Decoder liest die Bittiefe aus dem Strom. Hier stand bis dahin fest
    /// `false` mit der Behauptung, der Direktweg encodiere 8 bit — der
    /// Windows-Sidecar fährt aber auch hier 10 bit, wenn der Start es verlangt
    /// (`bit_depth: 10` oder `hdr`).
    /// Das Feld hält die Fähigkeit wahr für den Fall, dass ein Angebot je ein
    /// Profil nennt.
    pub zehn_bit: bool,
}

/// Die Bildspur: Zustand + Paketierer + Taktgeber, Form wie im WHIP-Sender.
pub(super) struct Bildspur {
    /// Zeitstempel-/Sequenz-Zustand + Paketierer unter EINEM Lock — beides
    /// wird pro Bild in einem Zug gebraucht.
    pub(super) zustand: Mutex<(SpurZustand, Paketierer)>,
    /// Verteilt die Pakete eines Bildes ueber die Zeit statt sie als Schwall
    /// zu senden (Zahlen in [`pacer`]). `PULSE_WHIP_PACING=0` schaltet auch
    /// hier die Verteilung zum Gegenmessen ab.
    pub(super) pacer: Option<pacer::Pacer>,
    pub(super) track: Arc<TrackLocalStaticRTP>,
}
