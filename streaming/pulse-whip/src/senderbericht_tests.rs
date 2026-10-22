//! Ende zu Ende ueber die Schleife: kommen die Senderberichte aus der
//! Aufnahmeuhr wirklich an, und NUR sie? Zwei echte Verbindungen (Sender aus
//! `sdp::baue_api`, Empfaenger mit den Interceptor-Vorgaben von webrtc-rs wie
//! ein Zuschauer), ICE auf 127.0.0.1.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice::network_type::NetworkType;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::sender_report::SenderReport;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecParameters, RTPCodecType};
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use crate::aufnahmeuhr::{Aufnahmeuhr, Spur};
use crate::sdp::{baue_api_mit_settings, codec_capability, opus_capability};
use crate::ton::TonSpur;

fn nur_schleife() -> SettingEngine {
    let mut se = SettingEngine::default();
    se.set_network_types(vec![NetworkType::Udp4]);
    se.set_ip_filter(Box::new(|ip| ip.is_loopback()));
    se.set_include_loopback_candidate(true);
    se
}

/// Angebot/Antwort samt Kandidaten (nicht-trickle), wie WHIP.
async fn verbinden(sender: &RTCPeerConnection, empfaenger: &RTCPeerConnection) {
    let offer = sender.create_offer(None).await.unwrap();
    let mut fertig = sender.gathering_complete_promise().await;
    sender.set_local_description(offer).await.unwrap();
    let _ = fertig.recv().await;
    empfaenger
        .set_remote_description(sender.local_description().await.unwrap())
        .await
        .unwrap();
    let answer = empfaenger.create_answer(None).await.unwrap();
    let mut fertig = empfaenger.gathering_complete_promise().await;
    empfaenger.set_local_description(answer).await.unwrap();
    let _ = fertig.recv().await;
    sender
        .set_remote_description(empfaenger.local_description().await.unwrap())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn berichte_tragen_die_aufnahmezeit_beider_spuren() {
    let video_cap = codec_capability("av1", 1280, 720, 60, false).unwrap();
    let audio_cap = opus_capability();
    let uhr = Aufnahmeuhr::neu();
    let api = baue_api_mit_settings(&video_cap, &audio_cap, 0, &uhr, nur_schleife()).unwrap();
    let sender = api.new_peer_connection(RTCConfiguration::default()).await.unwrap();
    let bild = Arc::new(TrackLocalStaticRTP::new(video_cap.clone(), "video".into(), "pulse-hq".into()));
    sender
        .add_track(Arc::clone(&bild) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .unwrap();
    let ton = TonSpur::neu(audio_cap.clone(), &uhr);
    sender.add_track(ton.spur()).await.unwrap();

    // Der Empfaenger meldet genau unsere Fassungen an (wie MediaMTX es fuer
    // seine tut); mit den webrtc-rs-Vorgaben bindet die Opus-Spur nicht, weil
    // deren fmtp-Zeile kein `stereo=1` traegt.
    let mut media = MediaEngine::default();
    for (fassung, pt, art) in [
        (video_cap.clone(), 96, RTPCodecType::Video),
        (audio_cap.clone(), 111, RTPCodecType::Audio),
    ] {
        media
            .register_codec(
                RTCRtpCodecParameters { capability: fassung, payload_type: pt, ..Default::default() },
                art,
            )
            .unwrap();
    }
    let registry = register_default_interceptors(Registry::new(), &mut media).unwrap();
    let empfaenger = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_setting_engine(nur_schleife())
        .build()
        .new_peer_connection(RTCConfiguration::default())
        .await
        .unwrap();
    for art in [RTPCodecType::Video, RTPCodecType::Audio] {
        empfaenger.add_transceiver_from_kind(art, None).await.unwrap();
    }
    // Je Spur: (ist Bild, Bericht). Gelesen wird auf dem Empfaenger, wie im
    // Player (`whep.rs`).
    let (tx, mut rx) = mpsc::unbounded_channel::<(bool, SenderReport)>();
    empfaenger.on_track(Box::new(move |spur, empfang, _| {
        let tx = tx.clone();
        let ist_bild = spur.kind() == RTPCodecType::Video;
        // Nur Berichte DIESER Spur — wie der Player (`whep.rs`).
        let ssrc = spur.ssrc();
        tokio::spawn(async move {
            while let Ok((pakete, _)) = empfang.read_rtcp().await {
                for p in pakete {
                    if let Some(sr) = p.as_any().downcast_ref::<SenderReport>().filter(|sr| sr.ssrc == ssrc) {
                        let _ = tx.send((ist_bild, sr.clone()));
                    }
                }
            }
        });
        // Die RTP-Pakete selbst muessen gelesen werden, sonst staut es.
        tokio::spawn(async move { while spur.read_rtp().await.is_ok() {} });
        Box::pin(async {})
    }));

    verbinden(&sender, &empfaenger).await;

    // 1,5 s lang Bild (60 fps, pts in 90 kHz) und Ton (10 ms, pts in 48 kHz)
    // ab demselben Nullpunkt — der Ton hinkt beim SENDEN 40 ms hinterher.
    // Genau diese Sendelatenz darf im Bericht nicht auftauchen.
    let start = tokio::time::Instant::now();
    let mut seq = 0u16;
    for schritt in 0..150u32 {
        let jetzt_ms = schritt * 10;
        tokio::time::sleep_until(start + Duration::from_millis(u64::from(jetzt_ms))).await;
        if schritt % 2 == 0 {
            let pts = jetzt_ms * 90;
            let p = Packet {
                header: Header { version: 2, marker: true, sequence_number: seq, timestamp: pts, ..Default::default() },
                payload: Bytes::from_static(&[0x10, 0x0a, 0, 0]),
            };
            seq = seq.wrapping_add(1);
            let _ = bild.write_rtp(&p).await;
        }
        if jetzt_ms >= 40 {
            let pts48 = i64::from(jetzt_ms - 40) * 48;
            let _ = ton.senden(&[0xF8, 0xFF, 0xFE], Some(pts48), Duration::from_millis(10)).await;
        }
    }

    // ALLE Berichte der Sendezeit (ein Bericht von webrtc-rs daneben bildete
    // die Sendezeit ab und laege beim Ton 40 ms daneben), plus etwas Nachlauf.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut berichte = Vec::new();
    while let Ok((ist_bild, sr)) = rx.try_recv() {
        berichte.push((ist_bild, sr));
    }
    assert!(berichte.iter().any(|(b, _)| *b), "kein Bild-Bericht");
    assert!(berichte.iter().any(|(b, _)| !*b), "kein Ton-Bericht");
    // Jeder Bericht bildet die Aufnahmezeit ab: pts(Marke) − NTP ist fuer
    // alle Berichte BEIDER Spuren dieselbe Zahl (−Wanduhr des Nullpunkts).
    let ntp_s = |n: u64| (n >> 32) as f64 + (n & 0xffff_ffff) as f64 / 4_294_967_296.0;
    let basis = ton_basis(&uhr);
    let abstaende: Vec<f64> = berichte
        .iter()
        .map(|(ist_bild, sr)| {
            let pts_s = if *ist_bild {
                f64::from(sr.rtp_time) / 90_000.0
            } else {
                f64::from(sr.rtp_time.wrapping_sub(basis) as i32) / 48_000.0
            };
            pts_s - ntp_s(sr.ntp_time)
        })
        .collect();
    let (min, max) = abstaende
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), &a| (lo.min(a), hi.max(a)));
    assert!(
        (max - min) * 1000.0 < 5.0,
        "{} Berichte bilden verschieden ab: Spanne {:.1} ms",
        berichte.len(),
        (max - min) * 1000.0
    );

    sender.close().await.unwrap();
    empfaenger.close().await.unwrap();
}

/// Die Ton-Basis aus der Uhr zurueckrechnen: Marke(Ton) − pts(jetzt) in 48 kHz,
/// mit pts(jetzt) aus der Bild-Marke desselben Augenblicks.
fn ton_basis(uhr: &Aufnahmeuhr) -> u32 {
    let jetzt = std::time::Instant::now();
    let bild = uhr.marke_jetzt(Spur::Bild, jetzt).unwrap();
    let ton = uhr.marke_jetzt(Spur::Ton, jetzt).unwrap();
    ton.wrapping_sub(((u64::from(bild) * 48_000 + 45_000) / 90_000) as u32)
}
