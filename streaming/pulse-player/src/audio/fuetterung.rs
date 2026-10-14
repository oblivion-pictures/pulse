//! Die Fuetterschleife der Tonausgabe: Befehle annehmen, Opus dekodieren,
//! verspaeteten Ton nach einem Unterlauf verwerfen, den Ring fuellen,
//! Grobkappung, Uhrenabgleich und Lippen-Regelung anstossen. Aus `audio.rs`
//! herausgeloest (Groessengrenze, `PLAN.md` §12.1) am 2026-10-14, im selben
//! Zug angepasst (Schwall-Erkennung, Lippen-Regler ohne Ringabweichung).

use std::sync::Mutex;
use std::time::Instant;

use super::lippen;
use super::opus::OpusDecoder;
use super::ringregelung::im_rueckstand;
use super::{AudioCommand, Shared};

/// Nimmt Befehle entgegen, bis der Sender weg ist oder `Stop` kommt.
/// `per_ms` = Samples je Millisekunde ueber alle Kanaele.
pub(super) fn pump_commands(
    rx: &std::sync::mpsc::Receiver<AudioCommand>,
    shared: &Mutex<Shared>,
    per_ms: usize,
    max_ring_samples: usize,
    // Fuer den Decoder, der hier lebt: Zielrate und Kanalzahl des Geraets.
    sample_rate: u32,
    channels: u16,
) {
    // Der Decoder lebt HIER, nicht beim Aufrufer, und wird beim ersten Paket
    // angelegt (das Geraet steht zu diesem Zeitpunkt schon).
    let mut decoder: Option<OpusDecoder> = None;
    let mut decoder_failed = false;
    // Einmalige Meldung, falls der Umrechner die Nachfuehrung nicht annimmt.
    let mut abgleich_gemeldet = false;
    while let Ok(cmd) = rx.recv() {
        // Dekodieren VOR der Sperre: auf dieselbe Sperre wartet der
        // Geraete-Callback, und ein Decode unter ihr wuerde ihn ausbremsen —
        // aus einem Bildruckler wuerde ein Tonaussetzer.
        let cmd = match cmd {
            AudioCommand::Packet(bytes, rtp_ts) => {
                if decoder.is_none() && !decoder_failed {
                    match OpusDecoder::new(sample_rate, channels) {
                        Ok(d) => decoder = Some(d),
                        Err(e) => {
                            eprintln!("pulse-player: Opus-Decoder: {e:#} — bleibt stumm");
                            decoder_failed = true;
                        }
                    }
                }
                let Some(dec) = decoder.as_mut() else { continue };
                match dec.decode(&bytes) {
                    Ok(pcm) => AudioCommand::Pcm(pcm, rtp_ts),
                    Err(e) => {
                        eprintln!("pulse-player: Opus-Decode: {e:#}");
                        continue;
                    }
                }
            }
            other => other,
        };
        let Ok(mut s) = shared.lock() else { break };
        // Was der Uhrenabgleich verlangt — gesetzt wird es NACH der Sperre: der
        // Umrechner gehoert dem Decoder, und unter der Sperre wartet der
        // Geraete-Callback.
        let mut stellgroesse = None;
        match cmd {
            // Oben in fertiges PCM verwandelt — hier kann es nicht mehr
            // auftreten.
            AudioCommand::Packet(..) => {}
            AudioCommand::Pcm(mut samples, rtp_ts) => {
                // Nach einem Unterlauf: was fuer die schon gespielte Stille
                // bestimmt war, verwerfen statt hinten anhaengen (s.
                // [`super::nachzuegler`]). VOR allem anderen — Ring, Kappung,
                // Uhrenabgleich und Lippen-Vermessung sehen nur den Rest.
                let rtp_ts = match rtp_ts {
                    Some(ts) => {
                        match s.verspaetetes_verwerfen(&mut samples, ts, sample_rate, channels) {
                            Some(rest_ts) => Some(rest_ts),
                            // Ganz verspaetet: nichts anzuhaengen, nichts zu vermessen.
                            None => continue,
                        }
                    }
                    None => None,
                };
                let angehaengt = samples.len();
                s.ring.extend(samples);
                // NACH dem Anhaengen kappen, nicht vorher: eine einzelne Charge
                // kann selbst groesser als die Ringgrenze sein, dann reichte das
                // Leeren des Alt-Rings nicht und die Grenze wurde dauerhaft
                // ueberschritten. Aelteste Daten weg — die sind ohnehin zu spaet.
                if s.ring.len() > max_ring_samples {
                    let excess = s.ring.len() - max_ring_samples;
                    s.ring.drain(..excess);
                    s.dropped += excess as u64;
                }
                s.zurueckfuehren();
                // Der eigentliche Ausgleich: die Abspielrate gegen die
                // Senderuhr nachfuehren, statt Ton wegzuschneiden. Beobachtet
                // wird der geglaettete Fuellstand — ausdruecklich nicht der
                // Wert hier und jetzt, der ist der Hochpunkt der Saegezahnkurve
                // (Begruendung in `uhrenabgleich`).
                let soll = s.target_fill;
                let fuellstand = s.ring.len();
                stellgroesse =
                    s.abgleich.beobachten(fuellstand, soll, angehaengt, per_ms, channels as usize);
                // Lippen-Vermessung und Regel-Eingriff (s. [`lippen`]): der
                // Fehler wird je Paket gemessen, der Eingriff rueckt nur um
                // Bruchteile des Fehlers weiter — der Uhrenabgleich darunter
                // kann höchstens 1 ms je Sekunde umsetzen, und ein Regler, der
                // schneller stellt als seine Strecke, schaukelt sich hoch.
                if let Some(ts) = rtp_ts {
                    let jetzt = Instant::now();
                    let ausgabe = s.ausgabe;
                    // Start-Vorhalt = aktueller Ring-Sollwert (s.
                    // `lippen::Tonuhr::startvorhalt_s`): ohne ihn waere die
                    // eigene Pufferlatenz ein Regel-Fehler.
                    let vorhalt_s = s.target_fill as f64 / (s.per_ms as f64 * 1000.0);
                    let uhr = s.tonuhr.get_or_insert_with(|| {
                        lippen::Tonuhr::neu(
                            ts,
                            ausgabe + (fuellstand - angehaengt) as u64,
                            jetzt,
                            vorhalt_s,
                        )
                    });
                    uhr.paket(ts, fuellstand, angehaengt, ausgabe, jetzt);
                    let fehler = uhr.fehler_ms(ausgabe, sample_rate, channels, jetzt);
                    // Gemeldet wird der rohe Fehler (so weit liegt der Ton
                    // wirklich daneben), geregelt der ohne Ringabweichung.
                    s.letzte_fehler_ms = fehler;
                    let mittel = s.abgleich.mittel().unwrap_or(fuellstand as f64);
                    let fehler_regel =
                        lippen::fehler_ohne_ringabweichung(fehler, mittel, s.target_fill, s.per_ms);
                    // Wann nicht geregelt wird (Stille, Vorfuellen nach einem
                    // Leerlauf, Rueckstand ueber der Kappschwelle), steht an
                    // `lippen::darf_nachfuehren`; der Zeitpunkt wird trotzdem
                    // erneuert. Ohne das integrierte der Regler am 2026-10-14
                    // je Aussetzer rund +600 ms Fehler, stand nach drei
                    // Aussetzern am Deckel, und der Ring lief auf 1 ms
                    // Sollwert in eine Unterlauf-Serie.
                    let rueckstand = im_rueckstand(fuellstand, s.kapp_schwelle());
                    let anlauf = s.anlauf;
                    match s.letzte_nachfuehr {
                        None => s.letzte_nachfuehr = Some(jetzt),
                        Some(zuletzt) => {
                            let dt = jetzt.duration_since(zuletzt).as_secs_f64();
                            if lippen::darf_nachfuehren(dt, anlauf, rueckstand) {
                                s.sync_ms = lippen::nachfuehren(s.sync_ms, fehler_regel, dt);
                                s.ziel_setzen();
                            }
                            s.letzte_nachfuehr = Some(jetzt);
                        }
                    }
                }
            }
            AudioCommand::Volume(v) => s.volume = v,
            AudioCommand::OffsetMs(ms) => {
                // Positiv = Ton spaeter = mehr Vorlauf im Ring.
                // Nie ueber die Ringgroesse hinaus: der Callback gibt erst
                // aus, wenn der Zielfuellstand erreicht ist. Laege der ueber
                // dem, was der Ring haelt, bliebe es dauerhaft still.
                // Der Trim ist ein ZUSCHLAG auf den Sollwert, kein Ersatz.
                // Bis 2026-08-05 stand hier nur `ms`, und damit hiess der
                // Vorgabewert 0 "gar kein Puffer" — s. `RING_SOLL_MS`.
                // Den Start-Vorhalt der Lippen-Vermessung mitziehen — sonst
                // regelte sie den Trim als Fehler wieder weg
                // (`lippen::Tonuhr::vorhalt_verschieben`). Nur der positive
                // Teil: nur er steckt im Sollwert (`ziel_setzen`).
                let vorher = s.trim_ms.max(0);
                s.trim_ms = ms;
                if let Some(uhr) = s.tonuhr.as_mut() {
                    uhr.vorhalt_verschieben(f64::from(ms.max(0) - vorher) / 1000.0);
                }
                s.ziel_setzen();
                if ms < 0 {
                    // Negativ = Ton frueher: vorhandenen Vorlauf kappen.
                    let n = ((-ms) as usize * per_ms).min(s.ring.len());
                    s.ring.drain(..n);
                }
            }
            AudioCommand::Stop => break,
        }
        drop(s);
        if let Some(stell) = stellgroesse {
            let angenommen =
                decoder.as_mut().is_some_and(|d| d.nachfuehren(stell.delta, stell.distanz));
            if !angenommen && !abgleich_gemeldet {
                abgleich_gemeldet = true;
                eprintln!(
                    "pulse-player: Uhren-Nachfuehrung abgelehnt (delta {}, Strecke {}) — \
                     der Ton laeuft ohne Ratenabgleich, der Ring haelt dann nur die \
                     Grobkappung",
                    stell.delta, stell.distanz
                );
            }
        }
    }
}
