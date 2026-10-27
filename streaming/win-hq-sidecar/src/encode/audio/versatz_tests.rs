//! Tests für [`super::Versatzbuch`] — samt Langlauf durch das echte
//! [`Aufnahmebuch`] (Budget, Drop, Stille, Gerätelücke), weil der Fehler von
//! 0.1.130 erst über die LAUFZEIT sichtbar wurde: ein stehender Stempel
//! ergibt in der ersten Sekunde einen harmlosen Versatz und nach einer Minute
//! einen von einer Minute.

use std::time::{Duration, Instant};

use super::Versatzbuch;
use crate::audio::aufnahmebuch::{Aufnahmebuch, Aufnahmezeit, Luecke, Schritt};

const RATE: u32 = 48_000;
const CHUNK: u64 = 480;
const QPC_HZ: f64 = 10_000_000.0;
/// Irgendein QPC-Wert, wie ihn ein seit Stunden laufender Rechner hat.
const T0: u64 = 50_000_000_000;

/// Was im Lauf passiert, in Sekunden ab dem Start.
#[derive(Clone, Copy)]
enum Ereignis {
    /// Das Gerät liefert nichts (stiller Desktop). `index_laeuft`: der
    /// Geräte-Index zählt in der Ruhe weiter (dann sieht der nächste
    /// Lesevorgang eine Lücke) oder steht.
    Ruhe { ab: f64, laenge: f64, index_laeuft: bool },
    /// Der Aufnahmefaden steht (Planer, Seitenfehler); die Daten dieser Zeit
    /// überschreibt das Gerät — der Index springt.
    Stau { ab: f64, laenge: f64 },
}

struct Ergebnis {
    max_abs_ms: f64,
    max_abs_am_ende_ms: f64,
    rueckfaelle: u32,
    ohne: u32,
    verworfen: u64,
    stille: u64,
    aufgefuellt: u64,
}

/// Einfacher, fester Zufall für den Stempel-Zitter (±0,2 ms).
fn zitter(zustand: &mut u64) -> i64 {
    *zustand = zustand.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    ((*zustand >> 33) % 4001) as i64 - 2000
}

/// Spielt `dauer_s` Sekunden Aufnahme + Encoder-Zählung durch. `stehend`
/// stempelt jeden Chunk mit dem Erst-Stempel — der Fehler von 0.1.130.
fn simuliere(ppm: f64, dauer_s: u64, ereignisse: &[Ereignis], stehend: bool) -> Ergebnis {
    let f_dev = f64::from(RATE) * (1.0 + ppm * 1e-6);
    let paket_s = CHUNK as f64 / f_dev;
    let origin_qpc = T0 + 3_000_000; // erstes Bild 300 ms nach Aufnahmestart
    let basis = Instant::now();
    let mut buch = Aufnahmebuch::neu(RATE, CHUNK as usize, T0);
    let mut versatz = Versatzbuch::neu(RATE, Duration::from_secs(10));
    let mut rnd = 1u64;
    // Gerät: nächstes Paket (Index, Aufnahmezeit seines ersten Frames in s).
    let (mut idx, mut c_s) = (0u64, 0.2);
    let mut pts: Option<i64> = None;
    let mut erg = Ergebnis {
        max_abs_ms: 0.0,
        max_abs_am_ende_ms: 0.0,
        rueckfaelle: 0,
        ohne: 0,
        verworfen: 0,
        stille: 0,
        aufgefuellt: 0,
    };
    let s_in_qpc = |s: f64| T0 + (s * QPC_HZ) as u64;
    let mut t_ms: u64 = 0;
    while t_ms < dauer_s * 1000 {
        let t_s = t_ms as f64 / 1000.0;
        let stau = ereignisse.iter().any(|e| matches!(*e,
            Ereignis::Stau { ab, laenge } if t_s >= ab && t_s < ab + laenge));
        if stau {
            t_ms += 1;
            continue;
        }
        // 1) hinausgeben, wie die Schleife in `wasapi.rs`
        loop {
            let faellig = t_ms * u64::from(RATE) / 1000;
            let zeit = match buch.schritt(faellig) {
                Schritt::Warten => break,
                Schritt::Verwerfen => {
                    erg.verworfen += 1;
                    continue;
                }
                Schritt::Echt { zeit, .. } => zeit,
                Schritt::Stille { zeit, .. } => {
                    erg.stille += 1;
                    zeit
                }
            };
            let zeit = if stehend {
                match buch.erster_qpc() {
                    0 => Aufnahmezeit::Unbekannt,
                    q => Aufnahmezeit::Geraet(q),
                }
            } else {
                zeit
            };
            let echt = zeit.qpc().map(|q| {
                ((q as i128 - origin_qpc as i128) * i128::from(RATE) / 10_000_000) as i64
            });
            // Verankerung wie `AudioPipeline::send`: erster Chunk setzt den pts.
            let gezaehlt = *pts.get_or_insert(echt.unwrap_or(0));
            let jetzt = basis + Duration::from_millis(t_ms);
            versatz.messen(echt, matches!(zeit, Aufnahmezeit::Geraet(_)), gezaehlt, jetzt);
            pts = Some(gezaehlt + CHUNK as i64);
            if t_s > 2.0 {
                let ms = versatz.versatz().abs() as f64 * 1000.0 / f64::from(RATE);
                erg.max_abs_ms = erg.max_abs_ms.max(ms);
                if t_s > dauer_s as f64 - 30.0 {
                    erg.max_abs_am_ende_ms = erg.max_abs_am_ende_ms.max(ms);
                }
            }
        }
        // 2) lesen, was das Gerät bis jetzt fertig hat
        loop {
            for e in ereignisse {
                if let Ereignis::Ruhe { ab, laenge, index_laeuft: false } = *e {
                    if c_s >= ab && c_s < ab + laenge {
                        c_s = ab + laenge; // Gerät steht, Index auch
                    }
                }
            }
            if c_s + paket_s + 0.001 > t_s {
                break;
            }
            let verloren = ereignisse.iter().any(|e| match *e {
                Ereignis::Ruhe { ab, laenge, index_laeuft: true } => c_s >= ab && c_s < ab + laenge,
                Ereignis::Stau { ab, laenge } => c_s + paket_s >= ab && c_s < ab + laenge,
                Ereignis::Ruhe { .. } => false,
            });
            if !verloren {
                let stempel = (s_in_qpc(c_s) as i64 + zitter(&mut rnd)) as u64;
                if let Luecke::Aufgefuellt(f) = buch.gelesen(idx, CHUNK, stempel, true) {
                    erg.aufgefuellt += f;
                }
            }
            idx += CHUNK;
            c_s += paket_s;
        }
        t_ms += 1;
    }
    erg.rueckfaelle = versatz.rueckfaelle;
    erg.ohne = versatz.ohne;
    erg
}

fn ereignisse_einer_stunde() -> Vec<Ereignis> {
    let mut e = Vec::new();
    for m in 0..6 {
        let ab = 300.0 + 600.0 * f64::from(m);
        // langer stiller Desktop, Index läuft (zu groß zum Auffüllen)
        e.push(Ereignis::Ruhe { ab, laenge: 5.0, index_laeuft: true });
        // kurzer stiller Desktop, Index steht
        e.push(Ereignis::Ruhe { ab: ab + 120.0, laenge: 1.5, index_laeuft: false });
        // Faden steht 140 ms, Gerät überschreibt -> Lücke wird aufgefüllt
        e.push(Ereignis::Stau { ab: ab + 240.0, laenge: 0.14 });
    }
    e
}

/// Der Kern-Test: über eine Stunde bleibt der Versatz beschränkt, ohne einen
/// einzigen Rückfall — bei schnellem, langsamem und genauem Gerätequarz, mit
/// Stille-Phasen, Gerätelücken und Drift-Drops. Mit dem stehenden Erst-Stempel
/// (0.1.130) fällt der Versatz um 1 s je Sekunde; s. Gegenprobe unten.
///
/// Schranken: am Ende 130 ms = Vorlauf-Budget (100 ms) + ein Paket bis zum
/// Lesen (10 ms) + ein Chunk vor dem Drop + Zitter. Unterwegs 300 ms: nach
/// einem Faden-Stau zählt die Simulation die Stauzeit doppelt (erst Stille
/// nach der Wanduhr, dann die aufgefüllte Gerätelücke — dieselbe Reihenfolge
/// wie `wasapi.rs`), der gezählte pts steht danach bis zu 100 ms + Lücke vor
/// der Uhr; die Aufnahmezeit zeigt genau das (in der Simulation −150 ms
/// kurz, danach −110 ms stehend).
#[test]
fn versatz_bleibt_ueber_eine_stunde_beschraenkt() {
    let ereignisse = ereignisse_einer_stunde();
    for ppm in [0.0, 500.0, -500.0] {
        let e = simuliere(ppm, 3600, &ereignisse, false);
        assert_eq!(e.rueckfaelle, 0, "{ppm} ppm: kein Rückfall auf die Zählung");
        assert_eq!(e.ohne, 0, "{ppm} ppm: jeder Chunk hat eine Aufnahmezeit");
        assert!(e.max_abs_ms < 300.0, "{ppm} ppm: Versatz {:.1} ms über der Schranke", e.max_abs_ms);
        assert!(
            e.max_abs_am_ende_ms < 130.0,
            "{ppm} ppm: am Ende {:.1} ms — der Versatz wandert",
            e.max_abs_am_ende_ms
        );
        assert!(e.stille > 0 && e.aufgefuellt > 0, "{ppm} ppm: Stille und Lücke müssen vorkommen");
        if ppm > 0.0 {
            assert!(e.verworfen > 0, "schneller Quarz muss Drift-Drops auslösen");
        }
    }
}

/// Gegenprobe: derselbe Lauf mit dem stehenden Erst-Stempel muss den Test
/// oben reißen — sonst prüft er nichts.
#[test]
fn gegenprobe_stehender_stempel_faellt_auf() {
    let e = simuliere(0.0, 120, &[], true);
    assert!(e.rueckfaelle > 1000, "stehender Stempel: {} Rückfälle", e.rueckfaelle);
}

/// Füllt das Gerät eine Lücke, deren Zeit schon als Stille hinausging (Index
/// läuft durch eine Ruhe unter 2 s), steht der Ton einmal doppelt im Strom:
/// Rückfall für einige Chunks — danach muss der Versatz zurückfinden.
#[test]
fn doppelte_stille_faellt_zurueck_und_erholt_sich() {
    let e = simuliere(
        0.0,
        60,
        &[Ereignis::Ruhe { ab: 10.0, laenge: 1.5, index_laeuft: true }],
        false,
    );
    assert!(e.rueckfaelle > 0, "der doppelte Ton muss als unplausibel auffallen");
    assert!(e.max_abs_am_ende_ms < 1000.0);
    let ende = simuliere(
        0.0,
        120,
        &[Ereignis::Ruhe { ab: 10.0, laenge: 1.5, index_laeuft: true }],
        false,
    );
    assert!(
        ende.max_abs_am_ende_ms < 130.0,
        "nach dem Rückfall erholt: {:.1} ms",
        ende.max_abs_am_ende_ms
    );
}

#[test]
fn rueckfall_ueber_einer_sekunde_meldet_einmal() {
    let mut b = Versatzbuch::neu(RATE, Duration::from_secs(10));
    let t = Instant::now();
    assert!(b.messen(Some(100), true, 0, t).is_none());
    assert_eq!(b.versatz(), 100);
    assert!(b.messen(Some(48_001), true, 0, t).is_some(), "erster Rückfall meldet");
    assert_eq!(b.versatz(), 0, "Rückfall = gezählter pts");
    assert!(b.messen(Some(-48_001), true, 0, t).is_none(), "zweiter schweigt");
    assert!(b.messen(None, false, 0, t).is_none());
    assert_eq!(b.versatz(), 0);
}

#[test]
fn zeile_alle_zehn_sekunden() {
    let mut b = Versatzbuch::neu(RATE, Duration::from_secs(10));
    let t = Instant::now();
    for v in [-1440, -960, -480] {
        b.messen(Some(v), true, 0, t);
    }
    b.messen(Some(0), false, 0, t);
    assert!(b.faellig(t + Duration::from_secs(9)).is_none());
    let zeile = b.faellig(t + Duration::from_secs(10)).unwrap();
    assert!(zeile.contains("p50 -20.0 / min -30.0 / max -10.0 ms (n=3)"), "{zeile}");
    assert!(zeile.contains("Stille-Chunks 1"), "{zeile}");
    assert!(b.faellig(t + Duration::from_secs(30)).is_none(), "neues Fenster erst mit neuem Wert");
}
