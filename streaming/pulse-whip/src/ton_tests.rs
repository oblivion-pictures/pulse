use super::*;

use crate::sdp::{baue_api, codec_capability, opus_capability, red_capability, PT_RED};
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecParameters, RTPCodecType};

const ZEHN_MS: Duration = Duration::from_millis(10);

/// Die Gegenseite, wie MediaMTX sie anmeldet: Opus 111 mit derselben
/// fmtp-Zeile wie der Sender, und auf einem neuen Server zusaetzlich
/// `audio/red` 48000/2 unter 63. Ein Bild meldet sie nicht an — der Test
/// fuehrt nur die Tonspur.
fn server(mit_red: bool) -> webrtc::api::API {
    let mut media = MediaEngine::default();
    if mit_red {
        media
            .register_codec(
                RTCRtpCodecParameters {
                    capability: red_capability(2),
                    payload_type: PT_RED,
                    ..Default::default()
                },
                RTPCodecType::Audio,
            )
            .unwrap();
    }
    media
        .register_codec(
            RTCRtpCodecParameters {
                capability: opus_capability(),
                payload_type: 111,
                ..Default::default()
            },
            RTPCodecType::Audio,
        )
        .unwrap();
    APIBuilder::new().with_media_engine(media).build()
}

/// Angebot/Antwort ohne Netz bis zur gesetzten Antwort auf der Senderseite;
/// liefert Spur, Sender und beide Verbindungen (zum Schliessen).
async fn ausgehandelt(
    mit_red: bool,
    angebot_kopien: u8,
) -> (TonSpur, Arc<RTCRtpSender>, RTCPeerConnection, RTCPeerConnection) {
    let video = codec_capability("h264", 1280, 720, 60, false).unwrap();
    let audio = opus_capability();
    let uhr = Aufnahmeuhr::neu();
    let api = baue_api(&video, &audio, angebot_kopien, &uhr).unwrap();
    let sender_pc = api.new_peer_connection(RTCConfiguration::default()).await.unwrap();
    let ton = TonSpur::neu(audio, &uhr);
    let sender = sender_pc.add_track(ton.spur()).await.unwrap();

    let offer = sender_pc.create_offer(None).await.unwrap();
    sender_pc.set_local_description(offer.clone()).await.unwrap();

    let server_pc = server(mit_red)
        .new_peer_connection(RTCConfiguration::default())
        .await
        .unwrap();
    server_pc.set_remote_description(offer).await.unwrap();
    let answer = server_pc.create_answer(None).await.unwrap();
    server_pc.set_local_description(answer.clone()).await.unwrap();

    // Der Punkt, an dem ein alter Server scheitern koennte: hier binden die
    // Spuren. Die Opus-Spur muss es auch ohne RED in der Antwort tun.
    sender_pc.set_remote_description(answer).await.unwrap();
    (ton, sender, sender_pc, server_pc)
}

async fn schliessen(a: RTCPeerConnection, b: RTCPeerConnection) {
    a.close().await.unwrap();
    b.close().await.unwrap();
}

#[tokio::test]
async fn neuer_server_mit_red_schaltet_um() {
    let (ton, sender, a, b) = ausgehandelt(true, 2).await;
    let art = ton.nach_aushandlung(&sender, 2).await.unwrap();
    assert_eq!(art, TonArt::Red { kopien: 2, opus_pt: 111 });
    let spur = sender.track().await.expect("Spur gebunden");
    let spur = spur.as_any().downcast_ref::<TrackLocalStaticRTP>().unwrap();
    assert_eq!(spur.codec().mime_type, MIME_TYPE_RED);
    schliessen(a, b).await;
}

#[tokio::test]
async fn alter_server_ohne_red_bleibt_opus() {
    let (ton, sender, a, b) = ausgehandelt(false, 2).await;
    let codecs = sender.get_parameters().await.rtp_parameters.codecs;
    assert!(
        codecs.iter().all(|c| !c.capability.mime_type.eq_ignore_ascii_case(MIME_TYPE_RED)),
        "{codecs:?}"
    );
    assert!(codecs.iter().any(|c| c.capability.mime_type == MIME_TYPE_OPUS));
    assert_eq!(ton.nach_aushandlung(&sender, 2).await.unwrap(), TonArt::Opus);
    let spur = sender.track().await.expect("Spur gebunden");
    let spur = spur.as_any().downcast_ref::<TrackLocalStaticRTP>().unwrap();
    assert_eq!(spur.codec().mime_type, MIME_TYPE_OPUS);
    schliessen(a, b).await;
}

#[tokio::test]
async fn kopien_null_bleibt_opus() {
    let (ton, sender, a, b) = ausgehandelt(true, 2).await;
    assert_eq!(ton.nach_aushandlung(&sender, 0).await.unwrap(), TonArt::Opus);
    let p = ton.paket_bauen(&[1, 2, 3], None, ZEHN_MS);
    assert_eq!(&p.payload[..], &[1, 2, 3]);
    schliessen(a, b).await;
}

#[tokio::test]
async fn red_block_traegt_die_ausgehandelte_opus_pt() {
    let (ton, sender, a, b) = ausgehandelt(true, 2).await;
    let TonArt::Red { opus_pt, .. } = ton.nach_aushandlung(&sender, 2).await.unwrap() else {
        panic!("nicht umgeschaltet");
    };
    let erstes = ton.paket_bauen(&[0xA], None, ZEHN_MS);
    assert_eq!(&erstes.payload[..], &[opus_pt, 0xA]);
    let zweites = ton.paket_bauen(&[0xB], None, ZEHN_MS);
    // Redundanzkopf (F=1, PT, Abstand 480, Laenge 1), Primaerkopf, Daten.
    assert_eq!(
        &zweites.payload[..],
        &[0x80 | opus_pt, (480 >> 6) as u8, ((480 & 0x3f) << 2) as u8, 1, opus_pt, 0xA, 0xB]
    );
    schliessen(a, b).await;
}

#[test]
fn sequenz_und_zeit_laufen_ueber() {
    let ton = TonSpur::mit_start(opus_capability(), u16::MAX, u32::MAX - 239);
    let p1 = ton.paket_bauen(&[1], None, ZEHN_MS);
    let p2 = ton.paket_bauen(&[2], None, ZEHN_MS);
    assert_eq!(
        (p1.header.sequence_number, p2.header.sequence_number),
        (65535, 0)
    );
    assert_eq!((p1.header.timestamp, p2.header.timestamp), (u32::MAX - 239, 240));
}

#[test]
fn opus_paket_wie_bisher() {
    let ton = TonSpur::mit_start(opus_capability(), 7, 1000);
    let p1 = ton.paket_bauen(&[9, 8, 7, 6], None, ZEHN_MS);
    let p2 = ton.paket_bauen(&[5], None, ZEHN_MS);
    assert_eq!(&p1.payload[..], &[9, 8, 7, 6]);
    assert!(p1.header.marker && p2.header.marker);
    assert_eq!(p1.header.version, 2);
    assert_eq!(p2.header.timestamp - p1.header.timestamp, 480);
    assert_eq!(p2.header.sequence_number, 8);
}

/// Die Dauer kommt als Bruchteil einer Sekunde und faellt in f64 knapp neben
/// den ganzen Takt; `paket_bauen` muss runden statt abzuschneiden, sonst laeuft
/// der Ton schleichend weg. 1/30 s ist der Fall, der die Falle frueher zeigte
/// (1599 statt 1600), 20 ms der Mac-Frame.
#[test]
fn nicht_ganze_takte_werden_gerundet() {
    let ton = TonSpur::neu(opus_capability(), &Aufnahmeuhr::default());
    let a = ton.paket_bauen(&[1], None, Duration::from_secs_f64(1.0 / 30.0));
    let b = ton.paket_bauen(&[2], None, Duration::from_secs_f64(1.0 / 30.0));
    assert_eq!(b.header.timestamp.wrapping_sub(a.header.timestamp), 1600);
    let c = ton.paket_bauen(&[3], None, Duration::from_millis(20));
    let d = ton.paket_bauen(&[4], None, Duration::from_millis(20));
    assert_eq!(d.header.timestamp.wrapping_sub(c.header.timestamp), 960);
}

/// Mit pts ist die Marke Basis + pts — auch ueber eine Luecke der Zeitlinie
/// hinweg, die im selben Paket ankommt und nicht erst im naechsten (so war es,
/// als die Marke die Summe der Dauern war).
#[test]
fn marke_ist_basis_plus_pts() {
    let ton = TonSpur::mit_start(opus_capability(), 1, 10_000);
    let a = ton.paket_bauen(&[1], Some(480), ZEHN_MS);
    let b = ton.paket_bauen(&[2], Some(960), ZEHN_MS);
    let c = ton.paket_bauen(&[3], Some(960 + 24_000), ZEHN_MS);
    assert_eq!(
        (a.header.timestamp, b.header.timestamp, c.header.timestamp),
        (10_480, 10_960, 34_960)
    );
}

/// Springt der pts zurueck oder steht er, geht die Marke trotzdem vorwaerts —
/// um die Dauer des letzten Rahmens; danach greift der pts wieder.
#[test]
fn marke_springt_nie_zurueck() {
    let ton = TonSpur::mit_start(opus_capability(), 1, 0);
    ton.paket_bauen(&[1], Some(4_800), ZEHN_MS);
    let zurueck = ton.paket_bauen(&[2], Some(4_000), ZEHN_MS);
    assert_eq!(zurueck.header.timestamp, 5_280);
    let gleich = ton.paket_bauen(&[3], Some(5_280), ZEHN_MS);
    assert_eq!(gleich.header.timestamp, 5_760);
    let weiter = ton.paket_bauen(&[4], Some(9_600), ZEHN_MS);
    assert_eq!(weiter.header.timestamp, 9_600);
}

/// Die Basis landet in der Aufnahmeuhr — ohne sie berichtete der Ton nie.
#[test]
fn basis_geht_an_die_uhr() {
    use crate::aufnahmeuhr::Spur;
    let uhr = Aufnahmeuhr::default();
    let ton = TonSpur::neu(opus_capability(), &uhr);
    let p = ton.paket_bauen(&[1], Some(0), ZEHN_MS);
    let t0 = std::time::Instant::now();
    uhr.paket(Spur::Ton, p.header.timestamp, t0);
    assert_eq!(uhr.marke_jetzt(Spur::Ton, t0), Some(p.header.timestamp));
}
