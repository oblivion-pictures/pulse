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
//! ruft bei PLI oder FIR [`crate::keyframe::request_keyframe`].
//!
//! **Nicht-Trickle.** WHIP ist ein einziger POST mit dem fertigen Angebot,
//! deshalb wird das Sammeln der ICE-Kandidaten abgewartet. Das unterscheidet
//! diesen Weg von `pulse-remote-webrtc` (Fernsteuerung), das als Answerer mit
//! Trickle-ICE arbeitet — dieselben Bauteile, andere Form.
//!
//! **Eine Bildspur, immer selbst gestempelt.** Die Spur ist fuer beide Codecs
//! eine `TrackLocalStaticRTP` — Reihenfolge, Marker-Bit und Zeitstempel setzt
//! dieser Weg selbst, und der WERT des Zeitstempels kommt aus dem `pts`, den
//! der Encoder mitgibt, nicht aus einem eigenen Zaehler (Begruendung an
//! `av1::SpurZustand::zeitstempel`). Nur die ZERLEGUNG unterscheidet sich:
//! AV1 und HEVC paketieren eigene Paketierer (webrtc-rs' `Av1Payloader`
//! schreibt Laengenfelder ab 128 falsch — Nachweis und Zahlen in [`av1`];
//! sein `HevcPayloader` verwirft IDR_N_LP lautlos — Live-Befund
//! 2026-09-13, Begründung in `pulse-whip::hevc`), H.264
//! zerlegt webrtc-rs' `H264Payloader` (Annex-B → FU-A/STAP-A, daran ist
//! nichts auszusetzen; er hält SPS/PPS zurück, HEVC sein Gegenstück
//! VPS/SPS/PPS im eigenen Paketierer). **Bis 2026-08-14 lief H.264 als
//! Sample-Spur**, bei
//! der webrtc-rs den Zeitstempel aus einer FESTEN Bilddauer hochzaehlte —
//! jedes ausgelassene Bild (verspaeteter Takt, EAGAIN-Verwurf) verschob die
//! Video-Uhr dauerhaft gegen Wanduhr und Ton. Fuer AV1 war genau das am
//! 2026-08-03 behoben worden; H.264 zieht hiermit nach.
//!
//! **Kopie aus `linux-hq-sidecar/src/whip/` (2026-08-20).** Nicht wortgleich —
//! die crate-eigenen Rueckgriffe unterscheiden sich. Was hier an der LOGIK
//! geaendert wird, gehoert dort nachgetragen.
//!
//! **Und das ist jetzt der einzige Schutz.** Seit `av1.rs` und `sdp.rs` am
//! 2026-08-20 gemeinsam in `pulse-whip` liegen, sind `mod.rs` und `pacer.rs`
//! die beiden LETZTEN Dateien des Sendewegs, die noch je Plattform doppelt
//! vorliegen — und kein Test haelt sie zusammen. Bis zum selben Tag gab es
//! hier eine `tests/zwillinge.rs`, die `av1.rs` und `sdp.rs` gegen die
//! Linux-Fassung hielt; sie verglich nach der Zusammenlegung nur noch zwei
//! Weiterleitungs-Einzeiler und wurde entfernt, weil ein Test, der gruen
//! bleibt ohne etwas zu pruefen, schlechter ist als gar keiner.

pub mod av1;
pub mod bildmarke;
mod pacer;
mod sdp;

use av1::SpurZustand;

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
use tokio::runtime::Runtime;
use webrtc::api::media_engine::{MIME_TYPE_AV1, MIME_TYPE_HEVC};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::codecs::h264::H264Payloader;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp::packetizer::Payloader;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use pulse_whip::ton::{TonArt, TonSpur};

/// Obergrenze fuers Sammeln der ICE-Kandidaten, bevor das Angebot trotzdem
/// rausgeht. Wie im Player (`pulse-player/src/whep.rs`).
const ICE_GATHERING_TIMEOUT: Duration = Duration::from_secs(2);

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
    /// `rtp`-Crates — der verwirft IDR_N_LP (20) lautlos, und genau den
    /// schreibt `hevc_videotoolbox` (Live-Befund 2026-09-13,
    /// Begründung in `pulse-whip::hevc`).
    Hevc(Vec<Vec<u8>>),
}

/// Ein Annex-B-Zeitabschnitt in RTP-Nutzlasten zerlegen — der Weg, den H.264
/// und HEVC gemeinsam nehmen. Der Payloader von webrtc-rs sagt nicht, ob ein
/// Vollbild dabei war; die Bildmarke braucht es fuer die Schablone, deshalb
/// kommt die Erkennung je Codec hier herein. Leer ist legitim: ein Paket, das
/// nur Parameter-Saetze trug (SPS/PPS bzw. VPS/SPS/PPS), wird vom Payloader
/// gemerkt und erst vor dem naechsten Vollbild ausgegeben.
///
/// Gleiche Funktion wie im Linux- und Windows-Sidecar (`whip::zerlege_annexb`)
/// — die drei Plattform-Dateien bleiben bewusst in lockstep, damit dieselbe
/// Lage nicht drei Formulierungen bekommt.
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
    /// Die extmap-Nummer, unter der die Bildmarke ausgehandelt wurde — 0 heisst
    /// "nicht ausgehandelt", dann wird keine geschrieben. Der Zuschauer urteilt
    /// dann gar nicht ("Marke oder nichts") statt auf Vermutungen.
    marken_id: AtomicU8,
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
}

/// Wohin die Soll/Ist-Zeile des Pacers geht — hier `eprintln!`, weil in diesem
/// Sidecar kein `tracing`-Subscriber laeuft (die Zeile ginge sonst ins Leere).
fn pacer_melder(soll_ms: f64, ist_ms: f64, pakete: usize) {
    eprintln!("[whip] Verteilung je Bild: soll {soll_ms:.2} ms, ist {ist_ms:.2} ms ({pakete} Pakete)");
}

/// Stau-Deckel des Taktgebers: Bild verworfen → sofort ein Vollbild anfordern
/// (derselbe Ort, den auch PLI/FIR bedienen), sonst reisst der Verwurf die
/// Bezugskette bis zum naechsten Vollbild-Takt auf.
fn stau_vollbild() {
    eprintln!("[whip] Sendestau: Bild verworfen — Vollbild angefordert");
    crate::keyframe::request_keyframe();
}

/// Zustandswechsel der Verbindung ins Log bringen — s. [`pulse_whip::verbindung`].
///
/// Bis zum 2026-08-27 sah hier niemand hin. **Beendet nichts**: der Abbau
/// haengt weiterhin allein am Schreibfehler (Begruendung im gemeinsamen
/// Modul).
fn verbindung_ueberwachen(pc: &Arc<RTCPeerConnection>) {
    pc.on_peer_connection_state_change(Box::new(move |zustand| {
        if let Some(lage) = pulse_whip::verbindung::peer_lage(zustand) {
            eprintln!("[whip] peer {zustand:?}: {}", lage.text());
        }
        Box::pin(async {})
    }));
    pc.on_ice_connection_state_change(Box::new(move |zustand| {
        if let Some(lage) = pulse_whip::verbindung::ice_lage(zustand) {
            eprintln!("[whip] ice {zustand:?}: {}", lage.text());
        }
        Box::pin(async {})
    }));
}

/// Eine REMB-Schaetzung der Gegenseite einordnen.
///
/// **Bis zum 2026-08-27 gab es das hier nicht** — `goog-remb` stand im
/// gemeinsamen Angebot, ausgewertet hat es nur Windows. Bewusst KEINE
/// automatische Anpassung der Datenrate; volle Begruendung am Zwilling im
/// Linux-Sidecar. `pub(crate)` seit dem Direktpfad: dessen RTCP-Lesefaden
/// (`direct/rueckkanal.rs`) ordnet REMB genauso ein — Zwilling
/// `win-hq-sidecar/src/whip/mod.rs` (dort `pub(crate)` von Anfang an).
pub(crate) fn remb_auswerten(
    wacht: &mut pulse_whip::bandbreite::BandbreitenWacht,
    bps: f32,
    ziel_kbps: u32,
) {
    use pulse_whip::bandbreite::Meldung;
    let jetzt = std::time::Instant::now();
    if let Some(meldung) = wacht.messung(bps, jetzt) {
        let (ev, schaetzung_kbps) = match meldung {
            Meldung::Eng { schaetzung_kbps } => {
                eprintln!(
                    "[whip] Leitung eng: Gegenseite schaetzt {schaetzung_kbps} kbps, \
                     Ziel {ziel_kbps} kbps"
                );
                ("bandwidth_low", schaetzung_kbps)
            }
            Meldung::Erholt { schaetzung_kbps } => {
                eprintln!(
                    "[whip] Leitung wieder tragfaehig: {schaetzung_kbps} kbps (Ziel {ziel_kbps})"
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
        eprintln!("[whip] REMB: Gegenseite schaetzt {:.0} kbps", bps / 1000.0);
    }
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

        // Kein STUN: der Weg zum eigenen Server laeuft entweder ueber die
        // Schleife oder ueber eine gewoehnliche ausgehende Verbindung. Ein
        // STUN-Server waere ein zusaetzlicher Aussenkontakt ohne Nutzen.
        let config = RTCConfiguration { ice_servers: vec![RTCIceServer::default()], ..Default::default() };
        let pc = Arc::new(api.new_peer_connection(config).await?);
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
        // Zweiter Griff auf denselben Sender: der RTCP-Faden unten verbraucht
        // `sender`, die extmap-Nummer der Bildmarke laesst sich aber erst NACH
        // der Aushandlung abfragen.
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
            |zeile| eprintln!("[whip] {zeile}"),
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
                            eprintln!("[whip] RTCP-Lesen beendet: {e}");
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        continue;
                    }
                };
                // Empfaengerberichte und NACKs des Servers zum Bild (s. Ton oben).
                if let Some(zeile) = strecke.rtcp(pulse_whip::strecke::Spur::Bild, &pakete) {
                    eprintln!("[whip] {zeile}");
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
                            crate::keyframe::request_keyframe();
                        }
                        angefordert += 1;
                        // JEDE melden, nicht nur jede zwanzigste. Der erste
                        // Anlauf meldete "die erste und dann jede zwanzigste" —
                        // damit sahen 1 und 19 Anforderungen identisch aus, und
                        // genau diese Unterscheidung war die Frage. Sie sind
                        // selten genug (rund zehn in 18 s bei 3 % Verlust), als
                        // dass das Log ueberliefe.
                        eprintln!("[whip] Vollbild angefordert (insgesamt {angefordert})");
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
                eprintln!("[whip] Ton mit Reserve: RED, {kopien} Kopien");
            }
            Ok(TonArt::Opus) if kopien > 0 => {
                eprintln!("[whip] Ton ohne Reserve: Server nimmt kein RED an");
            }
            Ok(TonArt::Opus) => {}
            Err(e) => {
                eprintln!("[whip] Ton-Reserve nicht eingerichtet, bleibt Opus: {e:#}");
            }
        }

        // Die Nummer, unter der die Bildmarke ausgehandelt wurde. Erst nach
        // `set_remote_description` (in `negotiate`) liefert webrtc-rs hier die
        // tatsaechlich ausgehandelten Erweiterungen; kennt der Server sie
        // nicht, ist die Liste leer und wir schreiben nichts. Der Zuschauer
        // urteilt dann gar nicht — "Marke oder nichts" statt Vermutung.
        let marken_id = sender_fuer_marke
            .get_parameters()
            .await
            .rtp_parameters
            .header_extensions
            .iter()
            .find(|e| e.uri == bildmarke::EXTMAP_URI)
            .map_or(0u8, |e| u8::try_from(e.id).unwrap_or(0));
        match marken_id {
            0 => eprintln!(
                "[whip] Bildmarke nicht ausgehandelt — der Zuschauer kann fehlende Bilder \
                 nicht erkennen (Server ohne Patch 0006?)"
            ),
            id => eprintln!("[whip] Bildmarke ausgehandelt als extmap {id}"),
        }

        Ok(Self { track, audio, pc, resource_url, http, marken_id: AtomicU8::new(marken_id) })
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
        let answer = res.text().await.context("Answer-Body")?;
        if !answer.contains("v=") {
            bail!("WHIP-Antwort war kein gueltiges SDP");
        }
        pc.set_remote_description(RTCSessionDescription::answer(answer)?)
            .await
            .context("set_remote_description")?;
        Ok((location, http))
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
            let marken_id = self.marken_id.load(Ordering::Relaxed);

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
                Paketierer::H264(p) => {
                    zerlege_annexb(p, data, pulse_whip::h264::h264_ist_vollbild, "H.264")?
                }
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
                        let marke = bildmarke::Bildmarke { anfang: erstes, ende: letztes, vollbild, nummer };
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
