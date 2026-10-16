use std::time::{Duration, Instant};

use super::{Kennzahlen, Uebergabefenster, kennzahlen};

/// Rangverfahren „nächster Rang": p50 von 1..=100 ist 50, p95 ist 95. Ein
/// interpolierendes Verfahren gäbe 50,5 — beides vertretbar, aber die Zeile
/// muss überall gleich rechnen, sonst vergleicht man zwei Messläufe mit zwei
/// Definitionen.
#[test]
fn kennzahlen_nach_naechstem_rang() {
    let mut werte: Vec<f64> = (1..=100).rev().map(f64::from).collect();
    assert_eq!(
        kennzahlen(&mut werte),
        Some(Kennzahlen { min: 1.0, p50: 50.0, p95: 95.0, n: 100 })
    );
    assert_eq!(kennzahlen(&mut Vec::new()), None, "leer heisst: nichts zu melden");
}

/// Erst nach Ablauf des Fensters kommt eine Zeile, danach beginnt es leer
/// von vorn — sonst mittelte die Zeile über die ganze Sitzung, und eine
/// Änderung mitten im Strom (10 bit an) verschwände im Durchschnitt.
#[test]
fn zeile_erst_nach_ablauf_und_dann_von_vorn() {
    let t0 = Instant::now();
    let mut f = Uebergabefenster::neu(Duration::from_secs(10));
    f.bild(20.0, t0);
    f.ton(30.0, t0);
    assert_eq!(f.faellig(t0 + Duration::from_secs(9)), None);
    assert!(f.faellig(t0 + Duration::from_secs(10)).is_some());
    assert_eq!(
        f.faellig(t0 + Duration::from_secs(21)),
        None,
        "nach der Zeile ist das Fenster leer — ohne neue Werte keine zweite"
    );
}

/// Das Vorzeichen ist die ganze Aussage: + heisst, der Ton verlässt den
/// Sender SPÄTER nach seiner Aufnahme als das Bild — beim Zuschauer, der nach
/// Ankunft verankert, klingt er dann zu spät. Gemeldet für das Minimum (daran
/// verankert MediaMTX) und für den Median.
#[test]
fn ton_spaeter_als_bild_ist_positiv() {
    let t0 = Instant::now();
    let mut f = Uebergabefenster::neu(Duration::from_secs(10));
    for ms in [20.0, 22.0, 24.0] {
        f.bild(ms, t0);
    }
    for ms in [60.0, 65.0, 70.0] {
        f.ton(ms, t0);
    }
    let zeile = f.faellig(t0 + Duration::from_secs(10)).unwrap();
    assert!(zeile.contains("Ton-Bild min +40.0 ms"), "{zeile}");
    assert!(zeile.contains("p50 +43.0 ms"), "{zeile}");
    assert!(zeile.contains("p95 +46.0 ms"), "{zeile}");
}

/// Ohne Tonspur (Stream ohne Ton) gibt es keinen Versatz — die Zeile meldet
/// das Bild und sagt, dass der Ton fehlt, statt eine Differenz zu erfinden.
#[test]
fn ohne_ton_kein_versatz() {
    let t0 = Instant::now();
    let mut f = Uebergabefenster::neu(Duration::from_secs(10));
    f.bild(20.0, t0);
    let zeile = f.faellig(t0 + Duration::from_secs(10)).unwrap();
    assert!(zeile.contains("Ton -"), "{zeile}");
    assert!(!zeile.contains("Ton-Bild"), "{zeile}");
}

/// Lücken der Ton-Zeitlinie (PTS-Sprung statt Rahmenlänge) zählen mit: MediaMTX
/// stempelt den Ton nach Paketzahl neu und sieht sie NICHT — jede Lücke ist
/// dort verlorene Zeit auf der Tonuhr.
#[test]
fn ton_luecken_werden_gezaehlt() {
    let t0 = Instant::now();
    let mut f = Uebergabefenster::neu(Duration::from_secs(10));
    f.ton(30.0, t0);
    f.ton_luecke(510);
    f.ton_luecke(20);
    let zeile = f.faellig(t0 + Duration::from_secs(10)).unwrap();
    assert!(zeile.contains("Ton-Luecken 2 (530 ms)"), "{zeile}");
}

/// Alter eines Pakets bei der Übergabe: Ursprung + Zeitstempel ist die
/// Aufnahmezeit, `jetzt` minus die das Alter. Vorzeichenbehaftet, denn ein
/// duplizierter Bildzeitstempel kommt aus einem Zähler und kann vor der Uhr
/// liegen — das muss als negativer Wert sichtbar sein, nicht als 0.
#[test]
fn alter_aus_ursprung_und_zeitstempel() {
    let ursprung = Instant::now();
    let jetzt = ursprung + Duration::from_millis(1_050);
    // 1 s in der 90-kHz-Bilduhr → 50 ms alt.
    assert!((super::alter_ms(ursprung, 90_000, 90_000, jetzt) - 50.0).abs() < 1e-6);
    // 48-kHz-Tonuhr, 1,1 s → 50 ms in der Zukunft.
    assert!((super::alter_ms(ursprung, 52_800, 48_000, jetzt) + 50.0).abs() < 1e-6);
}
