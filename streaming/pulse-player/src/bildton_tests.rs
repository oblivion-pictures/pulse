use std::time::{Duration, Instant};

use super::*;

/// NTP-Zeitstempel: obere 32 Bit Sekunden, untere 32 Bit Bruchteil.
#[test]
fn ntp_in_sekunden() {
    assert_eq!(ntp_s((5u64 << 32) | (1u64 << 31)), 5.5);
}

/// Eine RTP-Marke nach dem Report liegt um ihren Abstand / Takt später — auch
/// über den Überlauf der 32-Bit-Marke hinweg, und auch VOR dem Report.
#[test]
fn abbildung_rechnet_ueber_den_ueberlauf() {
    let sr = SrAbbildung::aus_bericht(100u64 << 32, u32::MAX - 899, 90_000);
    assert!((sr.ntp_fuer(100) - 100.0_f64 - 1000.0 / 90_000.0).abs() < 1e-9, "über den Überlauf");
    assert!((sr.ntp_fuer(u32::MAX - 899 - 9_000) - 99.9).abs() < 1e-9, "vor dem Report");
}

/// Der Kern: das gerade gezeigte Bild und der gerade klingende Ton in
/// Sender-Uhrzeit. Zeigt das Bild Inhalt von t=10,10 s und klingt Ton von
/// t=10,00 s, hinkt der Ton 100 ms hinterher → +100.
#[test]
fn ton_hinter_bild_ist_positiv() {
    let bild = SrAbbildung::aus_bericht(10u64 << 32, 0, 90_000);
    let ton = SrAbbildung::aus_bericht(10u64 << 32, 0, 48_000);
    let t = Instant::now();
    let v = versatz_ms(bild, 9_000, t, ton, 0, t).unwrap();
    assert!((v - 100.0).abs() < 1e-6, "{v}");
}

/// Ist das Bild schon eine Weile gezeigt, läuft seine Inhaltszeit seither
/// weiter (das nächste Bild kommt gleich) — sonst hinge das Ergebnis davon ab,
/// wann zwischen zwei Bildern gemessen wurde.
#[test]
fn seit_dem_zeigen_verstrichene_zeit_zaehlt_mit() {
    let bild = SrAbbildung::aus_bericht(10u64 << 32, 0, 90_000);
    let ton = SrAbbildung::aus_bericht(10u64 << 32, 0, 48_000);
    let gezeigt = Instant::now();
    let gemessen = gezeigt + Duration::from_millis(12);
    let v = versatz_ms(bild, 0, gezeigt, ton, 0, gemessen).unwrap();
    assert!((v - 12.0).abs() < 1e-6, "{v}");
}

/// Mehr als ein paar Sekunden Versatz ist keine Messung, sondern ein
/// unpassender Report (Senderwechsel, neue Sitzung) — verworfen statt gemeldet.
#[test]
fn unplausible_werte_werden_verworfen() {
    let bild = SrAbbildung::aus_bericht(10u64 << 32, 0, 90_000);
    let ton = SrAbbildung::aus_bericht(3_000u64 << 32, 0, 48_000);
    let t = Instant::now();
    assert_eq!(versatz_ms(bild, 0, t, ton, 0, t), None);
}

/// Die Zellen halten je Spur den letzten Report; ein Schnappschuss ist erst
/// vollständig, wenn beide Spuren einen hatten.
#[test]
fn zellen_halten_den_letzten_report_je_spur() {
    let z = SrZellen::default();
    assert!(z.stand().bild.is_none() && z.stand().ton.is_none());
    z.bericht(true, 1u64 << 32, 7, 90_000);
    z.bericht(false, 2u64 << 32, 9, 48_000);
    z.bericht(true, 3u64 << 32, 8, 90_000);
    let s = z.stand();
    assert_eq!(s.bild.unwrap().rtp, 8);
    assert_eq!(s.ton.unwrap().rtp, 9);
}

/// Die Logzeile kommt erst ab `mindestens` Proben — jede wiederkehrende Zeile
/// kostet den Diagnose-Upload Reichweite (er trägt nur das Ende des Logs) —,
/// meldet dann den Median und leert das Fenster.
#[test]
fn fenster_meldet_den_median_ab_genug_proben_und_leert_sich() {
    let mut f = Versatzfenster::default();
    assert_eq!(f.zeile(3), None, "ohne Proben keine Zeile");
    f.probe(30.0);
    f.probe(10.0);
    assert_eq!(f.zeile(3), None, "zu wenige Proben: warten, nicht leeren");
    f.probe(20.0);
    let z = f.zeile(3).unwrap();
    assert!(z.contains("Ton +20 ms hinter Bild"), "{z}");
    assert!(z.contains("n=3"), "{z}");
    assert_eq!(f.zeile(1), None, "danach leer");
}

/// Ohne Statistik-Log ruft niemand `zeile` — dann darf das Fenster nicht ohne
/// Ende wachsen (Sitzungen laufen Stunden). Es behält die jüngsten Proben.
#[test]
fn fenster_waechst_nicht_unbegrenzt() {
    let mut f = Versatzfenster::default();
    for i in 0..10_000 {
        f.probe(f64::from(i));
    }
    let z = f.zeile(1).unwrap();
    assert!(z.contains(&format!("n={}", super::HOECHSTENS_PROBEN)), "{z}");
}

/// Der erste Report je Spur wird gemeldet (Etappe 0b: „live prüfen, ob
/// Sender Reports ankommen") — fehlt die Zeile „Bild/Ton", muss man sehen
/// können, ob es an den Reports liegt.
#[test]
fn erster_report_je_spur_wird_erkannt() {
    let z = SrZellen::default();
    assert!(z.bericht(true, 1u64 << 32, 7, 90_000), "erster Bild-Report");
    assert!(!z.bericht(true, 2u64 << 32, 8, 90_000), "zweiter Bild-Report");
    assert!(z.bericht(false, 2u64 << 32, 9, 48_000), "erster Ton-Report");
}
