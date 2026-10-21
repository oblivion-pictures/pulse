use super::*;

/// 1/65536 s je Einheit im mittleren NTP-Wort.
fn einheiten(ms: u32) -> u32 {
    ms * 65_536 / 1000
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

#[test]
fn laufzeit_aus_lsr_und_dlsr() {
    let lsr = 0x1000_0000;
    // Bericht 1 s nach unserem Senderbericht abgeschickt, 50 ms später hier.
    let jetzt = lsr + 65_536 + einheiten(50);
    let rtt = laufzeit(lsr, 65_536, jetzt).unwrap();
    assert!(rtt.abs_diff(ms(50)) < ms(1), "{rtt:?}");
}

#[test]
fn laufzeit_ueber_den_ueberlauf_des_worts() {
    let lsr = u32::MAX - einheiten(10);
    let jetzt = lsr.wrapping_add(einheiten(30));
    let rtt = laufzeit(lsr, 0, jetzt).unwrap();
    assert!(rtt.abs_diff(ms(30)) < ms(1), "{rtt:?}");
}

#[test]
fn ohne_senderbericht_oder_unplausibel_keine_laufzeit() {
    // LSR 0: der Server hat noch keinen Senderbericht von uns gesehen.
    assert_eq!(laufzeit(0, 0, 12_345), None);
    // Ankunft „vor" dem Absenden (Uhrsprung): als Wort riesig, verworfen.
    assert_eq!(laufzeit(0x2000_0000, 65_536, 0x2000_0000), None);
}

#[test]
fn ntp_mitte_passt_zum_senderbericht() {
    let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000) + ms(250);
    let ntp = webrtc::rtp::extension::abs_send_time_extension::unix2ntp(t);
    assert_eq!(ntp_mitte(t), (ntp >> 16) as u32);
}

#[test]
fn anhaltender_stau_meldet_einmal_und_frei_einmal() {
    let t0 = Instant::now();
    let mut w = StauWacht::default();
    for k in 0..5 {
        assert_eq!(w.probe(ms(30), t0 + Duration::from_secs(k)), None);
    }
    // Ab 10 s: 160 ms Laufzeit = 130 ms Stau. Nach 3 s am Stück: eine Meldung.
    let mut meldungen = Vec::new();
    for k in 10..20 {
        meldungen.extend(w.probe(ms(160), t0 + Duration::from_secs(k)));
    }
    assert_eq!(meldungen, vec![Meldung::Eng { laufzeit: ms(160), stau: ms(130) }]);
    // Leicht gesunken, aber noch über der Frei-Schwelle: nichts.
    assert_eq!(w.probe(ms(80), t0 + Duration::from_secs(21)), None);
    assert_eq!(
        w.probe(ms(40), t0 + Duration::from_secs(22)),
        Some(Meldung::Frei { laufzeit: ms(40), stau: ms(10) })
    );
    assert_eq!(w.probe(ms(35), t0 + Duration::from_secs(23)), None);
}

#[test]
fn kurze_spitze_meldet_nichts() {
    let t0 = Instant::now();
    let mut w = StauWacht::default();
    w.probe(ms(30), t0);
    // Zwei Sekunden hoch, dann wieder normal: unter der Dauer-Schwelle.
    assert_eq!(w.probe(ms(200), t0 + Duration::from_secs(1)), None);
    assert_eq!(w.probe(ms(200), t0 + Duration::from_secs(2)), None);
    assert_eq!(w.probe(ms(200), t0 + Duration::from_millis(3_900)), None);
    assert_eq!(w.probe(ms(30), t0 + Duration::from_secs(4)), None);
    // Erneut hoch: die Dauer beginnt von vorn.
    assert_eq!(w.probe(ms(200), t0 + Duration::from_secs(5)), None);
    assert_eq!(w.probe(ms(200), t0 + Duration::from_secs(7)), None);
}

#[test]
fn grundwert_vergisst_nach_dem_fenster() {
    let t0 = Instant::now();
    let mut w = StauWacht::default();
    w.probe(ms(20), t0);
    w.probe(ms(50), t0 + Duration::from_secs(60));
    assert_eq!(w.grundwert(), Some(ms(20)));
    // Die 20 ms liegen jetzt über zwei Minuten zurück.
    w.probe(ms(50), t0 + Duration::from_secs(125));
    assert_eq!(w.grundwert(), Some(ms(50)));
}

#[test]
fn abschnitt_zeigt_hoechsten_stau_und_beginnt_neu() {
    let t0 = Instant::now();
    let mut w = StauWacht::default();
    assert_eq!(w.abschnitt_text(), None);
    w.probe(ms(31), t0);
    w.probe(ms(45), t0 + Duration::from_secs(1));
    w.probe(ms(38), t0 + Duration::from_secs(2));
    assert_eq!(
        w.abschnitt_text().as_deref(),
        Some("Laufzeit 38 ms (Grundwert 31 ms, Stau bis +14 ms)")
    );
    assert_eq!(w.abschnitt_text(), None);
}

#[test]
fn meldetexte() {
    assert_eq!(
        Meldung::Eng { laufzeit: ms(160), stau: ms(130) }.text(),
        "Leitung eng (Stau): Laufzeit 160 ms, 130 ms über dem Grundwert"
    );
    assert_eq!(
        Meldung::Frei { laufzeit: ms(40), stau: ms(10) }.text(),
        "Leitung wieder frei: Laufzeit 40 ms, 10 ms über dem Grundwert"
    );
}
