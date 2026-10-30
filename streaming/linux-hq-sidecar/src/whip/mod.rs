//! Eigener WebRTC-Sendeweg (WHIP) — statt ffmpegs Muxer.
//!
//! **Warum es das gibt.** Zwei Dinge kann ffmpegs WHIP-Muxer nicht, und beide
//! sind entscheidend:
//!
//! 1. **Kein Rueckkanal zur Anwendung.** Eine Vollbild-Anforderung des
//!    Zuschauers (RTCP PLI/FIR) koennte den Encoder nie erreichen. Gemessen am
//!    2026-07-28: ohne sie steht das Bild nach einem Paketverlust bis zum
//!    naechsten regulaeren Vollbild — bei 0,2 % Verlust in 7 bis 9 von 17
//!    Sekunden. MIT ihr sind es 0 bis 1, und die Bildrate geht von 0 auf 60.
//!    MediaMTX reicht die Anforderung nachweislich durch; es fehlte nur ein
//!    Sender, der sie empfaengt.
//! 2. **Kein AV1.** In ffmpeg 8.1 und im aktuellen master traegt `whip.c`
//!    ausschliesslich H.264 (`.p.video_codec = AV_CODEC_ID_H264`, ein einziger
//!    Payload-Typ). Es lohnt nicht, auf ein Update zu warten.
//!
//! **Aufbau.** Die Verbindung ist ein `RTCPeerConnection` mit genau einem
//! Video-Track. Encodierte Pakete kommen aus dem synchronen Encode-Faden
//! herein ([`WhipSender::send`]), werden dort in RTP-Pakete zerlegt und
//! gehen — per Vorgabe ueber den Taktgeber [`pacer`] verteilt — als
//! `write_rtp` hinaus. Ein eigener Faden liest das zurueckkommende RTCP und
//! ruft bei PLI oder FIR [`crate::encode::request_keyframe`].
//!
//! **Nicht-Trickle.** WHIP ist ein einziger POST mit dem fertigen Angebot,
//! deshalb wird das Sammeln der ICE-Kandidaten abgewartet. Das unterscheidet
//! diesen Weg von `pulse-remote-webrtc` (Fernsteuerung), das als Answerer mit
//! Trickle-ICE arbeitet — dieselben Bauteile, andere Form.
//!
//! **Eine Bildspur, immer selbst gestempelt.** Die Spur ist für alle drei
//! Codecs
//! eine `TrackLocalStaticRTP` — Reihenfolge, Marker-Bit und Zeitstempel setzt
//! dieser Weg selbst, und der WERT des Zeitstempels kommt aus dem `pts`, den
//! der Encoder mitgibt, nicht aus einem eigenen Zaehler (Begruendung an
//! `av1::SpurZustand::zeitstempel`). Nur die ZERLEGUNG unterscheidet sich:
//! AV1 und HEVC paketieren eigene Paketierer (webrtc-rs' `Av1Payloader`
//! schreibt Laengenfelder ab 128 falsch — Nachweis und Zahlen in [`av1`];
//! sein `HevcPayloader` verwirft IDR_N_LP/CRA lautlos — Live-Befund
//! 2026-09-13, Begründung in `pulse-whip::hevc`), H.264 zerlegt webrtc-rs'
//! `H264Payloader` (Annex-B → FU/STAP — daran ist nichts auszusetzen; er
//! hält SPS/PPS zurück, HEVC sein Gegenstück VPS/SPS/PPS im eigenen
//! Paketierer). **Bis 2026-08-14 lief H.264 als
//! Sample-Spur**, bei
//! der webrtc-rs den Zeitstempel aus einer FESTEN Bilddauer hochzaehlte —
//! jedes ausgelassene Bild (verspaeteter Takt, EAGAIN-Verwurf) verschob die
//! Video-Uhr dauerhaft gegen Wanduhr und Ton. Fuer AV1 war genau das am
//! 2026-08-03 behoben worden; H.264 zieht hiermit nach.
//!
//! **Und das ist jetzt der einzige Schutz.** Seit `av1.rs` und `sdp.rs` am
//! 2026-08-20 gemeinsam in `pulse-whip` liegen, sind `mod.rs` und `pacer.rs`
//! die beiden LETZTEN Dateien des Sendewegs, die noch je Plattform doppelt
//! vorliegen — und kein Test haelt sie zusammen.

pub mod bildmarke;
pub mod av1;
mod pacer;
mod sdp;

use av1::SpurZustand;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
use tokio::runtime::Runtime;
use webrtc::api::media_engine::{MIME_TYPE_AV1, MIME_TYPE_HEVC};
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::codecs::h264::H264Payloader;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp::packetizer::Payloader;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

/// Obergrenze fuers Sammeln der ICE-Kandidaten, bevor das Angebot trotzdem
/// rausgeht. Wie im Player (`pulse-player/src/whep.rs`).
const ICE_GATHERING_TIMEOUT: Duration = Duration::from_secs(2);

/// Groesster Antwortkoerper, den der WHIP-POST annimmt. Eine SDP-Antwort ist
/// wenige Kilobyte gross; 256 KiB lassen selbst fuer eine ungewoehnlich lange
/// Kandidatenliste reichlich Luft.
///
/// **Warum das eine Grenze braucht** (Security-Scan 24.10.2026): Bis dahin war
/// der 15-s-Timeout des HTTP-Clients die einzige Schranke, und `negotiate`
/// holte den Koerper mit `res.text()` vollstaendig in den Speicher, BEVOR
/// geprueft wurde, ob SDP drinsteht. Der Player hat dasselbe Muster schon
/// behoben (Bughunt 4, Befund 22: ein Stub, der `Content-Length: 209715200`
/// ankuendigt, wurde in 1,17 s vollstaendig los — weit innerhalb des
/// Timeouts); hier steht das Pendant fuer die Sender-Seite. Nachgemessen im
/// Regressionstest `repro_whip_antwort_ohne_groessengrenze`: ohne Deckel
/// schluckt der Sidecar alle 200 MB.
const MAX_ANSWER_BYTES: usize = 256 * 1024;

/// Eigene Laufzeit fuer den Sendeweg — bewusst getrennt von der des Portals.
///
/// Das Portal verhandelt einmal beim Start und ist danach still; dieser Weg
/// laeuft die ganze Sitzung. Sie sich teilen zu lassen hiesse, dass ein
/// haengender Portal-Aufruf den Medienstrom mit anhaelt.
fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("whip tokio runtime bauen")
    })
}

/// Wie ein encodiertes Bild in RTP-Nutzlasten zerfaellt.
enum Paketierer {
    /// Eigener AV1-Paketierer (s. [`av1`]).
    Av1,
    /// webrtc-rs' H.264-Zerleger (Annex-B → FU-A/STAP-A). Stateful: er merkt
    /// sich SPS/PPS und buendelt sie vor jedes Vollbild — deshalb liegt er
    /// mit im Spur-Zustand unter dem Lock.
    H264(H264Payloader),
    /// Eigener HEVC-Zerleger (`pulse_whip::hevc::paketiere`, Annex-B →
    /// FU/AP/Einzel-NAL), derselbe Trick wie H264: VPS/SPS/PPS im Puffer,
    /// gebuendelt vor dem nächsten Vollbild. NICHT der HevcPayloader des
    /// `rtp`-Crates — der verwirft IDR_N_LP (20) und CRA (21) lautlos
    /// (Live-Befund 2026-09-13, Begründung in `pulse-whip::hevc`).
    Hevc(Vec<Vec<u8>>),
}

/// Die Bildspur: eigene RTP-Pakete fuer beide Codecs.
struct Bildspur {
    /// Zeitstempel-/Sequenz-Zustand + Paketierer unter EINEM Lock — beides
    /// wird pro Bild in einem Zug gebraucht.
    zustand: Mutex<(SpurZustand, Paketierer)>,
    /// Verteilt die Pakete eines Bildes ueber die Zeit statt sie als Schwall
    /// zu senden (Zahlen in [`pacer`]). `PULSE_WHIP_PACING=0` schaltet die
    /// Verteilung zum Gegenmessen ab.
    pacer: Option<pacer::Pacer>,
    track: Arc<TrackLocalStaticRTP>,
}

pub struct WhipSender {
    track: Bildspur,
    /// Ton als EIGENE Spur.
    ///
    /// Der entscheidende Unterschied zum Muxer-Weg: dort liegen Bild und Ton
    /// auf EINER Zeitleiste, und der Muxer gibt ein Bild erst frei, wenn Ton mit
    /// passendem Zeitstempel vorliegt — der Rueckstand des Tons wird damit 1:1
    /// zur Bild-Latenz. Genau das kostete am 2026-07-28 ueber die echte Leitung
    /// rund 25 ms (RTMPS mit Ton 143, ohne Ton 116,8). Zwei getrennte Spuren
    /// koennen sich so nicht gegenseitig aufhalten.
    audio: Arc<TonSpur>,
    pc: Arc<RTCPeerConnection>,
    /// Aus dem `Location`-Kopf der Antwort — fuer das abschliessende DELETE.
    resource_url: Option<String>,
    http: reqwest::Client,
    /// Die ausgehandelte Nummer der Bildmarke; 0 = nicht ausgehandelt.
    ///
    /// Atomar, weil sie erst NACH dem Handschlag feststeht, `send` aber nur
    /// `&self` hat. Null als „gibt es nicht" ist zulaessig: RFC 8285 vergibt
    /// die Nummern ab 1.
    marken_id: std::sync::atomic::AtomicU8,
}

/// Traegt dieser H.264-Zeitabschnitt ein Vollbild (IDR)?
///
/// Der Payloader von webrtc-rs sagt es nicht, und die Bildmarke braucht es fuer
/// die Wahl der Schablone. Gesucht wird ueber die Annex-B-Startcodes, weil der
/// Encoder in diesem Format liefert — dasselbe, was `H264Payloader` erwartet.
///
/// H.264-Vollbild-Erkennung — liegt seit dem 2026-08-21 gemeinsam in
/// `pulse-whip::h264`. Hier nur noch durchgereicht, damit die Aufrufstelle
/// unveraendert bleibt.
use pulse_whip::h264::h264_ist_vollbild;
use pulse_whip::ton::{TonArt, TonSpur};

/// Ein Annex-B-Zeitabschnitt in RTP-Nutzlasten zerlegen — der Weg, den H.264
/// und HEVC gemeinsam nehmen. Der Payloader von webrtc-rs sagt nicht, ob ein
/// Vollbild dabei war; die Bildmarke braucht es fuer die Schablone, deshalb
/// kommt die Erkennung je Codec hier herein. Leer ist legitim: ein Paket, das
/// nur Parameter-Saetze trug (SPS/PPS bzw. VPS/SPS/PPS), wird vom Payloader
/// gemerkt und erst vor dem naechsten Vollbild ausgegeben.
fn zerlege_annexb<P: Payloader>(
    paketierer: &mut P,
    data: &[u8],
    vollbild: fn(&[u8]) -> bool,
    was: &str,
) -> Result<Vec<(Bytes, bool, bool, bool)>> {
    let teile = paketierer
        .payload(av1::MTU, &Bytes::copy_from_slice(data))
        .with_context(|| format!("{was} paketieren"))?;
    let n = teile.len();
    // Ein Vollbild gilt fuer den ganzen Abschnitt — einmal erkennen, nicht
    // je RTP-Paket.
    let ist_vollbild = vollbild(data);
    Ok(teile
        .into_iter()
        .enumerate()
        .map(|(i, b)| (b, i == 0, i + 1 == n, ist_vollbild))
        .collect())
}

/// Wohin die Soll/Ist-Zeile des Pacers geht — hier ueber `tracing`, wie der
/// Rest dieses Sidecars.
fn pacer_melder(soll_ms: f64, ist_ms: f64, pakete: usize) {
    tracing::info!(
        target: "whip",
        soll_ms = format!("{soll_ms:.2}"),
        ist_ms = format!("{ist_ms:.2}"),
        pakete,
        "Verteilung je Bild"
    );
}

/// Der Stau-Deckel des Taktgebers hat ein Bild fallen gelassen (Leitung laenger
/// als der Deckel im Rueckstand). Der Verwurf reisst die Bezugskette — sofort
/// ein Vollbild anfordern, exakt die Stelle, die auch eine PLI-Anforderung
/// bedient, sonst kauchen die folgenden Bilder bis zum naechsten Takt.
fn stau_vollbild() {
    tracing::warn!(
        target: "whip",
        "Sendestau: Bild verworfen — Vollbild angefordert"
    );
    crate::encode::request_keyframe();
}

/// Zustandswechsel der Verbindung ins Log bringen.
///
/// Bis zum 2026-08-27 sah hier niemand hin: ein Abriss nach dem Handschlag
/// wurde nur stumm bemerkt, wenn irgendwann ein Schreibfehler den Sendefaden
/// beendete. Einordnung und Wortlaut liegen gemeinsam in
/// [`pulse_whip::verbindung`], damit die drei Sidecars nicht drei
/// Formulierungen fuer dieselbe Lage erfinden; abgesetzt wird hier, weil nur
/// dieser Sidecar `tracing` benutzt.
///
/// **Beendet nichts.** Der Abbau haengt weiterhin allein am Schreibfehler —
/// Begruendung im Kopf des gemeinsamen Moduls.
fn verbindung_ueberwachen(pc: &Arc<RTCPeerConnection>) {
    pc.on_peer_connection_state_change(Box::new(move |zustand| {
        if let Some(lage) = pulse_whip::verbindung::peer_lage(zustand) {
            melde_lage("peer", lage, &format!("{zustand:?}"));
        }
        Box::pin(async {})
    }));
    pc.on_ice_connection_state_change(Box::new(move |zustand| {
        if let Some(lage) = pulse_whip::verbindung::ice_lage(zustand) {
            melde_lage("ice", lage, &format!("{zustand:?}"));
        }
        Box::pin(async {})
    }));
}

/// Eine Lage absetzen — `Weg` als Warnung, alles andere als Information.
fn melde_lage(ebene: &str, lage: pulse_whip::verbindung::Lage, zustand: &str) {
    if lage == pulse_whip::verbindung::Lage::Weg {
        tracing::warn!(target: "whip", ebene, zustand, "{}", lage.text());
    } else {
        tracing::info!(target: "whip", ebene, zustand, "{}", lage.text());
    }
}

/// Eine REMB-Schaetzung der Gegenseite einordnen: melden, was die Wacht sagt,
/// und im eigenen Takt eine Zeile fuers Messprotokoll.
///
/// **Bis zum 2026-08-27 gab es das hier nicht.** `goog-remb` steht im
/// gemeinsamen Angebot ([`pulse_whip::sdp`]) auf allen drei Plattformen, die
/// Auswertung lag aber nur unter Windows — Linux bat also um Berichte und warf
/// sie wortlos weg. Fuer den Nutzer hiess das: eine zu enge Leitung bricht das
/// Bild nicht, sie staut sich als wachsende Verzoegerung auf, und nirgends
/// stand eine Zahl.
///
/// **Bewusst KEINE automatische Anpassung der Datenrate.** Sie im Betrieb zu
/// aendern kostet ein Vollbild je Aenderung (NVENC: FFmpeg erzwingt dabei ein
/// IDR, s. `pulse_whip::bandbreite`; die Linux-Encoder sind darauf nicht
/// nachgeprueft). Das ist ein eigenes, zu messendes Vorhaben. Die Zahl, an
/// der es zu beurteilen waere, entstuende hier — nur kommt von MediaMTX kein
/// REMB (`pulse_whip::bandbreite`, Befund 2026-10-21); den Stau misst seither
/// `pulse_whip::stau` aus der Laufzeit.
fn remb_auswerten(
    wacht: &mut pulse_whip::bandbreite::BandbreitenWacht,
    bps: f32,
    ziel_kbps: u32,
) {
    use pulse_whip::bandbreite::Meldung;
    let jetzt = std::time::Instant::now();
    if let Some(meldung) = wacht.messung(bps, jetzt) {
        let (ev, schaetzung_kbps) = match meldung {
            Meldung::Eng { schaetzung_kbps } => {
                tracing::warn!(
                    target: "whip", schaetzung_kbps, ziel_kbps,
                    "Leitung eng: die Gegenseite schaetzt weniger als das Ziel"
                );
                ("bandwidth_low", schaetzung_kbps)
            }
            Meldung::Erholt { schaetzung_kbps } => {
                tracing::info!(
                    target: "whip", schaetzung_kbps, ziel_kbps,
                    "Leitung wieder tragfaehig"
                );
                ("bandwidth_ok", schaetzung_kbps)
            }
        };
        crate::events::emit(serde_json::json!({
            "ev": ev,
            "estimate_kbps": schaetzung_kbps,
            "target_kbps": ziel_kbps,
        }));
    }
    if wacht.log_faellig(jetzt) {
        tracing::info!(target: "whip", kbps = bps / 1000.0, "REMB-Schaetzung der Gegenseite");
    }
}

/// Liest den Antwortkoerper des WHIP-POST **gestreamt** und bricht ab, sobald
/// er [`MAX_ANSWER_BYTES`] ueberschreitet. Ein angekuendigtes `Content-Length`
/// darueber wird gar nicht erst gelesen; fehlt der Kopf oder luegt er, faengt
/// die laufende Zaehlung ueber die Stuecke es ab.
///
/// Der Abbruchgrund ist derselbe wie bei einer inhaltlich unbrauchbaren
/// Antwort ("kein gueltiges SDP") — was diese Groesse hat, IST keine
/// SDP-Antwort mehr, und der Anrufer muss beide Faelle gleich behandeln.
/// Pendant zu `lies_answer_begrenzt` im Player (`pulse-player/src/whep.rs`,
/// dort Befund 22); der Regressionstest `repro_whip_antwort_ohne_
/// groessengrenze` haelt beide Seiten zusammen.
async fn lies_answer_begrenzt(mut res: reqwest::Response) -> Result<String> {
    if res.content_length().is_some_and(|n| n > MAX_ANSWER_BYTES as u64) {
        bail!(
            "WHIP-Antwort war kein gueltiges SDP: angekuendigte {} Byte \
             ueberschreiten die Obergrenze von {MAX_ANSWER_BYTES} Byte",
            res.content_length().unwrap_or(0)
        );
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(stueck) = res.chunk().await.context("Answer-Body")? {
        if body.len() + stueck.len() > MAX_ANSWER_BYTES {
            bail!(
                "WHIP-Antwort war kein gueltiges SDP: laenger als die \
                 Obergrenze von {MAX_ANSWER_BYTES} Byte"
            );
        }
        body.extend_from_slice(&stueck);
    }
    String::from_utf8(body)
        .map_err(|_| anyhow!("WHIP-Antwort war kein gueltiges SDP: kein UTF-8"))
}

/// Nur gleiche Herkunft folgen — verhindert, dass ein manipulierter
/// `Location`-Kopf das abschliessende DELETE auf einen fremden Host umlenkt
/// (Security-Scan 24.10.2026). Gleiche Regel wie im Player und im
/// Browser-Client.
fn resolve_resource_url(whip_url: &str, location: &str) -> Option<String> {
    let base = reqwest::Url::parse(whip_url).ok()?;
    let resolved = base.join(location).ok()?;
    let same_origin = resolved.scheme() == base.scheme()
        && resolved.host_str() == base.host_str()
        && resolved.port_or_known_default() == base.port_or_known_default();
    same_origin.then(|| resolved.to_string())
}

impl WhipSender {
    /// Baut die Sitzung auf und kehrt zurueck, sobald das Angebot beantwortet
    /// ist. Blockiert den aufrufenden (synchronen) Faden waehrenddessen.
    pub fn connect(
        url: &str,
        codec: &str,
        fps: u32,
        breite: u32,
        hoehe: u32,
        bitrate_kbps: u32,
        zehn_bit: bool,
    ) -> Result<Self> {
        let cap = sdp::codec_capability(codec, breite, hoehe, fps, zehn_bit)?;
        let fps = fps.max(1);
        runtime().block_on(async move { Self::connect_async(url, cap, fps, bitrate_kbps).await })
    }

    async fn connect_async(
        url: &str,
        cap: RTCRtpCodecCapability,
        fps: u32,
        bitrate_kbps: u32,
    ) -> Result<Self> {
        // Der echte Bildabstand — geht an den Taktgeber (`pacer`). Die
        // Bild-Zeitstempel selbst kommen aus dem Encoder-`pts`
        // (`av1::SpurZustand::zeitstempel`), nicht aus einer Dauer.
        let frame_duration = Duration::from_secs_f64(1.0 / f64::from(fps));

        // Baut die Media-Engine so, dass im Angebot GENAU unsere Fassungen
        // stehen: Bild, Opus und mit `kopien > 0` RED (Begruendung und Messung
        // im Kopf von [`sdp`]).
        let audio_cap = sdp::opus_capability();
        // Eine Zahl fuer Angebot und Nachpruefung (`nach_aushandlung`).
        let kopien = pulse_whip::red::kopien_aus_umgebung();
        // Eine Aufnahmeuhr fuer beide Spuren: die Senderberichte tragen damit
        // die Aufnahmezeit statt der Sendezeit (`pulse_whip::senderbericht`).
        let uhr = pulse_whip::aufnahmeuhr::Aufnahmeuhr::neu();
        let api = sdp::baue_api(&cap, &audio_cap, kopien, &uhr)?;

        // STUN, damit der Server uns auch erreicht, wenn er eingehend sperrt
        // (Begruendung bei `sdp::eis_konfiguration`).
        let pc = Arc::new(api.new_peer_connection(sdp::eis_konfiguration()).await?);
        verbindung_ueberwachen(&pc);

        // Beide Codecs stempeln selbst; nur der Zerleger unterscheidet sich
        // (Grund und Nachweis in [`av1`] bzw. im Modulkopf).
        let paketierer = match cap.mime_type.as_str() {
            MIME_TYPE_AV1 => Paketierer::Av1,
            MIME_TYPE_HEVC => Paketierer::Hevc(Vec::new()),
            _ => Paketierer::H264(H264Payloader::default()),
        };
        let video_track = Arc::new(TrackLocalStaticRTP::new(
            cap,
            "video".to_owned(),
            "pulse-hq".to_owned(),
        ));
        let track = Bildspur {
            zustand: Mutex::new((SpurZustand::neu(fps), paketierer)),
            // AN als Vorgabe seit dem Neubau mit absoluten Zeitpunkten und
            // Paket-Gruppen (s. [`pacer`]); `PULSE_WHIP_PACING=0` ist der
            // Gegenmess-Schalter.
            pacer: (std::env::var("PULSE_WHIP_PACING").as_deref() != Ok("0")).then(|| {
                pacer::Pacer::start(runtime(), Arc::clone(&video_track), frame_duration, pacer_melder, stau_vollbild)
            }),
            track: video_track,
        };
        let sender = pc
            .add_track(Arc::clone(&track.track) as Arc<dyn TrackLocal + Send + Sync>)
            .await?;
        // Zweite Referenz: `sender` wandert gleich in die RTCP-Schleife, die
        // ausgehandelte Nummer der Bildmarke steht aber erst nach dem
        // Handschlag fest und wird weiter unten gelesen.
        let sender_fuer_marke = Arc::clone(&sender);

        // Ton-Spur IMMER anbieten, auch wenn kein Ton kommt.
        //
        // Die Spuren werden beim Handschlag ausgehandelt; eine nachtraeglich
        // hinzugefuegte verlangt eine neue Aushandlung, und die kennt WHIP in
        // seiner einfachen Form nicht (ein POST, eine Antwort). Eine angebotene
        // und stumme Spur kostet dagegen nichts — anders als beim Muxer, wo ein
        // angekuendigter, aber stummer Strom den Interleaver puffern liesse.
        let audio = Arc::new(TonSpur::neu(audio_cap, &uhr));
        let audio_sender = pc.add_track(audio.spur()).await?;
        let sender_fuer_ton = Arc::clone(&audio_sender);

        // Auch der Ton-Sender MUSS gelesen werden (ungelesene Rueckmeldungen
        // stauen den Sender). Seit 2026-10-14 nicht mehr nur leergelesen: die
        // Empfaengerberichte des Servers sagen, wie viele Tonpakete auf der
        // Strecke hierher fehlten (`pulse_whip::strecke`).
        let strecke = pulse_whip::strecke::Strecke::neu();
        tokio::spawn(pulse_whip::strecke::ton_rueckkanal(
            audio_sender,
            Arc::clone(&strecke),
            |zeile| tracing::info!(target: "whip", "{zeile}"),
        ));

        // RTCP lesen. PLI und FIR sind die Bitte um ein Vollbild; REMB,
        // Empfaengerberichte und NACKs werden ausgewertet, der Rest verworfen —
        // gelesen werden MUSS aber alles, sonst staut der Sender.
        //
        // `PULSE_WHIP_IGNORE_PLI=1` liest weiter, antwortet aber nicht. Das ist
        // kein Betriebsschalter, sondern der Trennschnitt einer Messung: nur so
        // laesst sich sagen, ob eine Verbesserung unter Verlust von den
        // Vollbildern kommt oder vom Transportweg selbst.
        let antworten = std::env::var("PULSE_WHIP_IGNORE_PLI").as_deref() != Ok("1");
        tokio::spawn(async move {
            let mut angefordert: u64 = 0;
            let mut bandbreite = pulse_whip::bandbreite::BandbreitenWacht::neu(bitrate_kbps);
            // Fehler beim Lesen duerfen den Rueckkanal NICHT dauerhaft
            // schliessen.
            //
            // Zuerst stand hier `while let Ok(..) = read_rtcp().await` — und
            // damit verliess ein einziger Lesefehler die Schleife fuer immer.
            // Am 2026-07-28 auf der Leitung nachgesehen: MediaMTX schickte zehn
            // Vollbild-Anforderungen, angekommen ist genau EINE, und zwar bei
            // jedem Verlustgrad von 0,2 bis 8 % dieselbe eine. Das sah nach
            // "der Server leitet nicht weiter" aus und war ein Fehler bei uns.
            let mut fehler_am_stueck = 0u32;
            loop {
                let (pakete, _) = match sender.read_rtcp().await {
                    Ok(v) => {
                        fehler_am_stueck = 0;
                        v
                    }
                    Err(e) => {
                        fehler_am_stueck += 1;
                        // Ein paar Fehler hintereinander heissen "Verbindung
                        // ist weg" — dann darf die Schleife enden, sonst
                        // liefe sie heiss.
                        if fehler_am_stueck >= 5 {
                            tracing::debug!(target: "whip", "RTCP-Lesen beendet: {e}");
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        continue;
                    }
                };
                // Empfaengerberichte und NACKs des Servers zum Bild (s. Ton oben).
                if let Some(zeile) = strecke.rtcp(pulse_whip::strecke::Spur::Bild, &pakete) {
                    tracing::info!(target: "whip", "{zeile}");
                }
                for p in &pakete {
                    let any = p.as_any();
                    if let Some(remb) = any.downcast_ref::<ReceiverEstimatedMaximumBitrate>() {
                        remb_auswerten(&mut bandbreite, remb.bitrate, bitrate_kbps);
                    }
                    if any.downcast_ref::<PictureLossIndication>().is_some()
                        || any.downcast_ref::<FullIntraRequest>().is_some()
                    {
                        if antworten {
                            crate::encode::request_keyframe();
                        }
                        angefordert += 1;
                        // JEDE melden, nicht nur jede zwanzigste. Der erste
                        // Anlauf meldete "die erste und dann jede zwanzigste" —
                        // damit sahen 1 und 19 Anforderungen identisch aus, und
                        // genau diese Unterscheidung war die Frage. Sie sind
                        // selten genug (rund zehn in 18 s bei 3 % Verlust), als
                        // dass das Log ueberliefe.
                        tracing::info!(
                            target: "whip",
                            "Vollbild angefordert (insgesamt {angefordert})"
                        );
                    }
                }
            }
        });

        // Bughunt Runde 4: scheitert die Aushandlung (Server down, WHIP-POST
        // abgelehnt), würde das `?` die PeerConnection offen liegen lassen —
        // webrtc-rs räumt beim Drop nichts ab, pro Fehlversuch bliebe ein
        // voller PC-Zustand samt ICE-Agent und Lesetasks im Prozess (Spiegel
        // zu pulse-player/src/whep.rs, wo derselbe Fall explizit abbaut).
        let (resource_url, http) = match Self::negotiate(&pc, url).await {
            Ok(ergebnis) => ergebnis,
            Err(e) => {
                let _ = pc.close().await;
                return Err(e);
            }
        };

        // Ton: RED, wenn der Server es angenommen hat (sonst bleibt es Opus).
        // Vor dem ersten `send_audio` — `connect` gibt die Sitzung erst jetzt her.
        match audio.nach_aushandlung(&sender_fuer_ton, kopien).await {
            Ok(TonArt::Red { kopien, .. }) => {
                tracing::info!(target: "whip", "Ton mit Reserve: RED, {kopien} Kopien");
            }
            Ok(TonArt::Opus) if kopien > 0 => {
                tracing::info!(target: "whip", "Ton ohne Reserve: Server nimmt kein RED an");
            }
            Ok(TonArt::Opus) => {}
            Err(e) => {
                tracing::warn!(target: "whip", "Ton-Reserve nicht eingerichtet, bleibt Opus: {e:#}");
            }
        }

        // Die Nummer, unter der die Bildmarke ausgehandelt wurde. Nach
        // `set_remote_description` liefert webrtc-rs hier genau die
        // ausgehandelten Erweiterungen; kennt der Server sie nicht, ist die
        // Liste leer und wir schreiben nichts. Der Zuschauer urteilt dann gar
        // nicht — „Marke oder nichts".
        let marken_id = sender_fuer_marke
            .get_parameters()
            .await
            .rtp_parameters
            .header_extensions
            .iter()
            .find(|e| e.uri == bildmarke::EXTMAP_URI)
            .map_or(0u8, |e| u8::try_from(e.id).unwrap_or(0));
        match marken_id {
            0 => tracing::warn!(
                target: "whip",
                "Bildmarke nicht ausgehandelt — der Zuschauer kann fehlende Bilder \
                 nicht erkennen (Server ohne Patch 0006?)"
            ),
            id => tracing::info!(target: "whip", "Bildmarke ausgehandelt als extmap {id}"),
        }

        Ok(Self {
            track,
            audio,
            pc,
            resource_url,
            http,
            marken_id: std::sync::atomic::AtomicU8::new(marken_id),
        })
    }

    /// Angebot erzeugen, Kandidaten sammeln, POST, Antwort setzen.
    async fn negotiate(
        pc: &Arc<RTCPeerConnection>,
        url: &str,
    ) -> Result<(Option<String>, reqwest::Client)> {
        let offer = pc.create_offer(None).await.context("create_offer")?;
        pc.set_local_description(offer).await.context("set_local_description")?;

        // Nicht-Trickle: warten, bis das Angebot alle Kandidaten traegt.
        let mut gathering = pc.gathering_complete_promise().await;
        let _ = tokio::time::timeout(ICE_GATHERING_TIMEOUT, gathering.recv()).await;
        let sdp = pc
            .local_description()
            .await
            .ok_or_else(|| anyhow!("keine local description nach dem Sammeln"))?
            .sdp;

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("HTTP-Client")?;
        let res = http
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/sdp")
            .body(sdp)
            .send()
            .await
            // NICHT `.context(...)`: reqwest haengt die volle URL an den Fehler,
            // und die traegt den Publish-Token. Projektregel: niemals Tokens
            // loggen.
            .map_err(|e| anyhow!("WHIP-Server nicht erreichbar: {}", crate::redact::redact_url(&e.to_string())))?;
        if !res.status().is_success() {
            bail!("WHIP-POST fehlgeschlagen: HTTP {}", res.status());
        }
        let location = res
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let answer = lies_answer_begrenzt(res).await?;
        if !answer.contains("v=") {
            bail!("WHIP-Antwort war kein gueltiges SDP");
        }
        pc.set_remote_description(RTCSessionDescription::answer(answer)?)
            .await
            .context("set_remote_description")?;
        // Nur gleiche Herkunft folgen (Security-Scan 24.10.2026): der Server,
        // der den `Location`-Kopf liefert, darf nicht beliebige DELETE-Ziele
        // vorgeben koennen. Fremde Herkunft → keine Resource-URL → das DELETE
        // bleibt aus; die Sitzung laeuft beim Server ohnehin aus.
        Ok((
            location.and_then(|loc| resolve_resource_url(url, &loc)),
            http,
        ))
    }

    /// Ein encodiertes Bild senden.
    ///
    /// `pts` ist der Zeitstempel des Encoder-Pakets in der ENCODER-Zeitbasis —
    /// und die IST seit 2026-08-14 die 90-kHz-RTP-Uhr (`crate::zeitbasis`),
    /// die Uebergabe an die Spur also eine Identitaet
    /// (`av1::SpurZustand::zeitstempel`).
    pub fn send(&self, data: &[u8], pts: Option<i64>) -> Result<()> {
        let Bildspur { zustand, pacer, track } = &self.track;
        let pakete: Vec<Packet> = {
            let mut g = zustand.lock().expect("Spur-Zustand vergiftet");
            let (z, paketierer) = &mut *g;
            // Alle Pakete eines Bildes tragen denselben Zeitstempel.
            let ts = z.zeitstempel(pts);
            let marken_id = self.marken_id.load(std::sync::atomic::Ordering::Relaxed);
            // Erst paketieren, DANN nummerieren. Geht nichts hinaus, wird auch
            // keine Bildnummer verbraucht — daran erkennt der Zuschauer, dass
            // nichts verlorenging (`crate::whip::bildmarke`).
            //
            // Je Eintrag: Nutzlast, erstes Paket, letztes Paket, Vollbild.
            let teile: Vec<(Bytes, bool, bool, bool)> = match paketierer {
                Paketierer::Av1 => av1::paketiere(data, av1::MTU)?
                    .into_iter()
                    .map(|p| (Bytes::from(p.daten), p.erstes, p.letztes, p.vollbild))
                    .collect(),
                Paketierer::H264(p) => zerlege_annexb(p, data, h264_ist_vollbild, "H.264")?,
                Paketierer::Hevc(p) => pulse_whip::hevc::paketiere(p, data, av1::MTU)?
                    .into_iter()
                    .map(|p| (Bytes::from(p.daten), p.erstes, p.letztes, p.vollbild))
                    .collect(),
            };
            if teile.is_empty() {
                return Ok(());
            }
            let nummer = z.naechste_bildnummer();
            teile
                .into_iter()
                .map(|(daten, erstes, letztes, vollbild)| {
                    let mut header = Header {
                        version: 2,
                        // `letztes` = letztes Paket des Bildes (→ Marker-Bit).
                        marker: letztes,
                        sequence_number: z.naechste_seq(),
                        timestamp: ts,
                        ..Default::default()
                    };
                    if marken_id != 0 {
                        let marke = bildmarke::Bildmarke {
                            anfang: erstes,
                            ende: letztes,
                            vollbild,
                            nummer,
                        };
                        // Ein Fehler waere hier ein Programmierfehler (unzu-
                        // laessige Nummer), kein Betriebsfall. Ein Strom ohne
                        // Marke ist besser als kein Strom, deshalb kein `?`.
                        let _ = header
                            .set_extension(marken_id, Bytes::from(bildmarke::schreiben(&marke)));
                    }
                    Packet { header, payload: daten }
                })
                .collect()
        };
        match pacer {
            Some(p) => p.send(pakete),
            None => {
                for paket in pakete {
                    runtime().block_on(track.write_rtp(&paket)).context("write_rtp")?;
                }
                Ok(())
            }
        }
    }

    /// Ein encodiertes Ton-Paket senden.
    ///
    /// `pts` = Aufnahmezeit in 48-kHz-Takten ab dem gemeinsamen Nullpunkt mit
    /// dem Bild — daraus stempelt die gemeinsame Tonspur (`pulse_whip::ton`,
    /// seit 2026-10-22), und nur so bilden die Senderberichte beider Spuren
    /// dieselbe Aufnahmezeit ab. `dauer` (der PTS-SPRUNG seit dem letzten
    /// Paket, `encode::audio::AudioEncoder::whip_dauer`) zaehlt nur ohne `pts`.
    pub fn send_audio(&self, data: &[u8], pts: Option<i64>, dauer: Duration) -> Result<()> {
        runtime().block_on(self.audio.senden(data, pts, dauer)).context("Ton senden")
    }

    /// Sitzung abbauen. Idempotent.
    ///
    /// Nimmt `&self`, weil der Sender geteilt wird: der Ton-Faden haelt eine
    /// eigene Referenz. Das abschliessende DELETE ist ohnehin best-effort —
    /// zweimal geschickt ist harmlos, der Server laesst die Sitzung sonst
    /// auslaufen.
    pub fn close(&self) {
        let pc = Arc::clone(&self.pc);
        let url = self.resource_url.clone();
        let http = self.http.clone();
        runtime().block_on(async move {
            let _ = pc.close().await;
            if let Some(u) = url {
                let _ = http.delete(&u).send().await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Bildmarke waehlt ihre Schablone daran. Ein SPS/PPS-Paket ohne
    /// Vollbild darf NICHT als Vollbild gelten — der Payloader haelt es
    /// zurueck, und eine Schablone fuer ein Bild, das gar nicht hinausgeht,
    /// waere schon deshalb falsch.
    #[test]
    fn h264_idr_wird_erkannt() {
        assert!(h264_ist_vollbild(&[0, 0, 0, 1, 0x65, 0xAA]), "langer Startcode, NAL-Typ 5");
        assert!(h264_ist_vollbild(&[0, 0, 1, 0x65, 0xAA]), "kurzer Startcode, NAL-Typ 5");
        assert!(!h264_ist_vollbild(&[0, 0, 0, 1, 0x41, 0xAA]), "NAL-Typ 1 ist ein Differenzbild");
        assert!(
            h264_ist_vollbild(&[0, 0, 1, 0x67, 0, 0, 1, 0x68, 0, 0, 1, 0x65]),
            "SPS und PPS vor dem IDR"
        );
        assert!(!h264_ist_vollbild(&[0, 0, 1, 0x67, 0, 0, 1, 0x68]), "SPS und PPS allein");
        assert!(!h264_ist_vollbild(&[]));
        assert!(!h264_ist_vollbild(&[0, 0, 1]), "Startcode ohne Kopf laeuft nicht ueber");
    }

    /// Ein WHIP-Endpunkt antwortet mit HTTP 200 und kuendigt 200 MB Body an.
    ///
    /// **Security-Scan 24.10.2026** — das Pendant zu Befund 22 der Bughunt 4
    /// (`repro_22` im Player, `pulse-player/src/whep.rs`): Bis hierher stand
    /// in `negotiate` ein nacktes `res.text().await` — der Sidecar holte die
    /// volle Antwort in den Speicher, BEVOR er pruefte, ob ueberhaupt SDP
    /// drinsteht, und der 15-s-Timeout des HTTP-Clients war die einzige
    /// Schranke. Ein feindseliger oder uebernommener WHIP-Endpunkt konnte den
    /// Sendeweg damit beliebig aufblaehen.
    ///
    /// Gemessen wird nicht der Speicher (schlecht beobachtbar), sondern was
    /// die Gegenstelle loswerden konnte (dieselbe Methode wie im Player):
    /// mit der Obergrenze bricht der Client an der angekuendigten Groesse ab,
    /// ohne den Koerper zu lesen, und der Stub bringt nur noch das los, was
    /// die Socket-Puffer schon geschluckt hatten — nicht die vollen 200 MB.
    /// Die genaue Zahl ist keine Eigenschaft des Codes (Kernpuffer variieren);
    /// alles, was um Groessenordnungen unter `ANGEKUENDIGT` liegt, belegt den
    /// Abbruch.
    /// Nur gleiche Herkunft: ein manipulierter `Location`-Kopf darf das
    /// abschliessende DELETE nicht auf einen fremden Host lenken
    /// (**Security-Scan 24.10.2026** — der Server, der die Location liefert,
    /// konnte bislang beliebige DELETE-Ziele vorgeben). Spiegel zu
    /// `resource_url_nur_bei_gleicher_herkunft` im Player.
    #[test]
    fn resource_url_nur_bei_gleicher_herkunft() {
        let base = "https://howispulse.com/whip/x?token=abc";
        assert_eq!(
            resolve_resource_url(base, "/whip/session/1").as_deref(),
            Some("https://howispulse.com/whip/session/1")
        );
        // Fremder Host wird verworfen — das DELETE bleibt dann einfach aus
        // (der Server laesst die Sitzung ohnehin auslaufen).
        assert_eq!(resolve_resource_url(base, "https://evil.example/x"), None);
        assert_eq!(resolve_resource_url(base, "http://howispulse.com/x"), None);
    }

    #[test]
    fn repro_whip_antwort_ohne_groessengrenze() {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicU64, Ordering};

        /// Was der Stub hoechstens loswerden DARF — gross genug, dass
        /// Socket-Puffer verschiedener Maschinen darunter bleiben, klein
        /// genug, dass ein Client ohne Begrenzung sicher darueber liegt.
        const ERLAUBT: u64 = 16 * 1024 * 1024;
        /// Was er ankündigt (und ohne Begrenzung auch loswird).
        const ANGEKUENDIGT: u64 = 200 * 1024 * 1024;

        fn kopfende(roh: &[u8]) -> Option<usize> {
            roh.windows(4).position(|f| f == b"\r\n\r\n").map(|p| p + 4)
        }
        fn content_length(kopf: &[u8]) -> usize {
            String::from_utf8_lossy(kopf)
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse().ok())?
                })
                .unwrap_or(0)
        }

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let geschrieben = Arc::new(AtomicU64::new(0));
        let zaehler = geschrieben.clone();

        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            // Erst die Anfrage (Kopf + Offer-SDP) abnehmen, sonst haengt der
            // Client im Senden statt im Lesen.
            let mut roh = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).expect("read");
                if n == 0 {
                    break;
                }
                roh.extend_from_slice(&buf[..n]);
                if let Some(p) = kopfende(&roh) {
                    if roh.len() - p >= content_length(&roh[..p]) {
                        break;
                    }
                }
            }
            let kopf = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\n\
                 Content-Length: {ANGEKUENDIGT}\r\n\r\n"
            );
            if stream.write_all(kopf.as_bytes()).is_err() {
                return;
            }
            let block = vec![0u8; 64 * 1024];
            let mut rest = ANGEKUENDIGT;
            while rest > 0 {
                let n = (block.len() as u64).min(rest) as usize;
                if stream.write_all(&block[..n]).is_err() {
                    break; // Client hat abgebrochen — genau das ist der Fix
                }
                zaehler.fetch_add(n as u64, Ordering::Relaxed);
                rest -= n as u64;
            }
        });

        let ergebnis = WhipSender::connect(
            &format!("http://{addr}/whip"), "h264", 30, 64, 64, 1000, false,
        );
        let fehler = match ergebnis {
            Ok(_) => panic!("die Sitzung darf mit dieser Antwort nicht zustande kommen"),
            Err(e) => format!("{e:#}"),
        };
        let _ = server.join();

        let n = geschrieben.load(Ordering::Relaxed);
        eprintln!("Stub konnte {n} Bytes absetzen; Fehler des Sidecars: {fehler}");
        // Der Abbruchgrund nennt die angekuendigte Groesse — er kommt aus der
        // Pruefung VOR dem Lesen, nicht aus der SDP-Pruefung dahinter.
        assert!(
            fehler.contains("kein gueltiges SDP"),
            "unerwarteter Abbruchgrund (Test misst dann etwas anderes): {fehler}"
        );
        assert!(
            n <= ERLAUBT,
            "der Sidecar hat {n} Bytes Antwortkoerper geschluckt \
             (erlaubt waeren hoechstens {ERLAUBT}) — keine Groessenbegrenzung"
        );
    }
}
