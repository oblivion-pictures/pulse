use super::*;

use webrtc::rtcp::transport_feedbacks::transport_layer_nack::NackPair;

const SSRC: u32 = 0xB11D;

fn rr(ssrc: u32, total_lost: u32, seq: u32, jitter: u32) -> Box<dyn Packet + Send + Sync> {
    Box::new(ReceiverReport {
        reports: vec![ReceptionReport {
            ssrc,
            total_lost,
            last_sequence_number: seq,
            jitter,
            ..Default::default()
        }],
        ..Default::default()
    })
}

fn nack(paare: &[(u16, u16)]) -> Box<dyn Packet + Send + Sync> {
    Box::new(TransportLayerNack {
        media_ssrc: SSRC,
        nacks: paare
            .iter()
            .map(|&(packet_id, lost_packets)| NackPair { packet_id, lost_packets })
            .collect(),
        ..Default::default()
    })
}

fn s(sek: f64) -> Duration {
    Duration::from_secs_f64(sek)
}

#[test]
fn vorzeichen_der_24_bit_zahl() {
    assert_eq!(total_lost_i32(0), 0);
    assert_eq!(total_lost_i32(5), 5);
    assert_eq!(total_lost_i32(0x7F_FFFF), 8_388_607);
    assert_eq!(total_lost_i32(0xFF_FFFF), -1);
    assert_eq!(total_lost_i32(0x80_0000), -8_388_608);
}

#[test]
fn zuwachs_anteil_und_regeltakt() {
    let t0 = Instant::now();
    let st = Strecke::neu_ab(t0);
    // Gesund, und noch keine 10 s: keine Zeile.
    assert_eq!(st.rtcp_zu(Spur::Bild, &[rr(SSRC, 0, 1000, 0)], t0 + s(1.0)), None);
    // Drei verloren auf 1000 erwartete: sofort eine Zeile (≥ 1 s seit Beginn).
    let z = st.rtcp_zu(Spur::Bild, &[rr(SSRC, 3, 2000, 0)], t0 + s(2.0)).unwrap();
    assert!(z.starts_with("Strecke zum Server (2,0 s) — "), "{z}");
    assert!(z.contains("Bild: verloren +3 (gesamt 3), Anteil 0,3 %, Nachforderungen +0"), "{z}");
    assert!(z.ends_with("Ton: keine Rückmeldung"), "{z}");
    // Wieder gesund: erst nach dem Regelabstand ab der LETZTEN Zeile.
    assert_eq!(st.rtcp_zu(Spur::Bild, &[rr(SSRC, 3, 3000, 0)], t0 + s(11.0)), None);
    let z = st.rtcp_zu(Spur::Bild, &[rr(SSRC, 3, 4000, 0)], t0 + s(12.0)).unwrap();
    assert!(z.contains("Bild: verloren +0 (gesamt 3), Anteil 0,0 %"), "{z}");
}

#[test]
fn verlust_hoechstens_einmal_je_sekunde() {
    let t0 = Instant::now();
    let st = Strecke::neu_ab(t0);
    assert!(st.rtcp_zu(Spur::Ton, &[rr(SSRC, 0, 100, 0)], t0 + s(0.5)).is_none());
    assert!(st.rtcp_zu(Spur::Ton, &[rr(SSRC, 2, 200, 0)], t0 + s(1.0)).is_some());
    // Weiterer Verlust eine halbe Sekunde später: gedrosselt, aber gezählt.
    assert!(st.rtcp_zu(Spur::Ton, &[rr(SSRC, 4, 300, 0)], t0 + s(1.5)).is_none());
    let z = st.rtcp_zu(Spur::Ton, &[rr(SSRC, 5, 400, 0)], t0 + s(2.0)).unwrap();
    assert!(z.contains("Ton: verloren +3 (gesamt 5), Anteil 1,5 %, Jitter"), "{z}");
    assert!(z.contains("Bild: keine Rückmeldung;"), "{z}");
}

#[test]
fn erster_bericht_zaehlt_ganz_aber_ohne_anteil() {
    let t0 = Instant::now();
    let st = Strecke::neu_ab(t0);
    let z = st.rtcp_zu(Spur::Ton, &[rr(SSRC, 7, 500, 0)], t0 + s(1.0)).unwrap();
    assert!(z.contains("Ton: verloren +7 (gesamt 7), Anteil –,"), "{z}");
}

#[test]
fn rueckgang_und_ueberlauf_des_zaehlers() {
    let t0 = Instant::now();
    let st = Strecke::neu_ab(t0);
    // Verlust, aber vor Ablauf einer Sekunde: noch keine Zeile.
    assert!(st.rtcp_zu(Spur::Bild, &[rr(SSRC, 10, 0xFFFF_FFF0, 0)], t0 + s(0.1)).is_none());
    // Zähler sinkt (Neubeginn): kein Zuwachs, nur neue Basis.
    assert!(st.rtcp_zu(Spur::Bild, &[rr(SSRC, 2, 0xFFFF_FFF8, 0)], t0 + s(0.2)).is_none());
    // Erweiterte Nummer läuft über 32 Bit: 0xFFFF_FFF8 → 0x20 = 40 erwartet.
    let z = st.rtcp_zu(Spur::Bild, &[rr(SSRC, 4, 0x20, 0)], t0 + s(1.2)).unwrap();
    // +10 aus dem ersten Bericht (davor nichts gesehen), +2 nach dem Rückgang;
    // der Anteil nur aus dem Schritt danach: 2 von 40.
    assert!(z.contains("Bild: verloren +12 (gesamt 4), Anteil 5,0 %"), "{z}");
}

#[test]
fn jitter_in_ms_je_takt_und_hoechstwert() {
    let t0 = Instant::now();
    let st = Strecke::neu_ab(t0);
    // Bild: 90 kHz, 900 Takte = 10 ms; Ton: 48 kHz, 240 Takte = 5 ms.
    st.rtcp_zu(Spur::Bild, &[rr(SSRC, 0, 10, 900)], t0 + s(1.0));
    st.rtcp_zu(Spur::Bild, &[rr(SSRC, 0, 20, 450)], t0 + s(2.0));
    let z = st.rtcp_zu(Spur::Ton, &[rr(SSRC + 1, 0, 10, 240)], t0 + s(10.0)).unwrap();
    assert!(z.contains("Jitter bis 10,0 ms; Ton"), "{z}");
    assert!(z.ends_with("Jitter bis 5,0 ms"), "{z}");
}

#[test]
fn nachforderungen_fremde_ssrc_und_stille() {
    let t0 = Instant::now();
    let st = Strecke::neu_ab(t0);
    // Ohne jeden Bericht keine Zeile, auch nach dem Regelabstand nicht.
    assert_eq!(st.rtcp_zu(Spur::Bild, &[nack(&[(5, 0)])], t0 + s(20.0)), None);
    // Der erste Bericht holt die Zeile nach — samt der Nachforderung davor.
    let z = st.rtcp_zu(Spur::Bild, &[rr(SSRC, 0, 100, 0)], t0 + s(21.0)).unwrap();
    assert!(z.contains("Nachforderungen +1,"), "{z}");
    // Fremde SSRC: übergangen, die Basis bleibt die eigene.
    assert!(st.rtcp_zu(Spur::Bild, &[rr(SSRC + 9, 50, 9000, 0)], t0 + s(22.0)).is_none());
    // 1 + 2 gesetzte Bits + 1 = 4 angeforderte Pakete.
    let pakete = [nack(&[(7, 0b101), (40, 0)]), rr(SSRC, 0, 200, 0)];
    let z = st.rtcp_zu(Spur::Bild, &pakete, t0 + s(31.0)).unwrap();
    assert!(z.contains("Bild: verloren +0 (gesamt 0), Anteil 0,0 %, Nachforderungen +4"), "{z}");
    // Danach wieder still: keine weitere Zeile, auch nach dem Regelabstand.
    assert_eq!(st.rtcp_zu(Spur::Bild, &[], t0 + s(45.0)), None);
}
