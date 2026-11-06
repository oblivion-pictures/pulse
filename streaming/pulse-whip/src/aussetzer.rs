//! Ein Paket, das das Betriebssystem mangels Sendepuffer ablehnt, ist ein
//! Aussetzer und kein Abbruch.
//!
//! **Befund (2026-11-06, Windows-Sender 0.1.146).** Ein Fortnite-Start neben
//! einem laufenden HQ-Stream beendete den Stream mit `senken-writer
//! gescheitert: Ton senden: Tonpaket schreiben: … (os error 10055)`. 10055 ist
//! `WSAENOBUFS`: Windows hatte für einen Augenblick keinen Puffer für das
//! UDP-Paket. Die Strecke war bis zu diesem Paket sauber (0 % Verlust, 22 ms
//! Laufzeit, Strecke-Zeile 10 s davor). Derselbe Abbruch steht am 2026-11-01
//! zweimal in den Diagnose-Logs. Dass der Spielstart die Warteschlange füllt,
//! ist aus dem Zeitpunkt gefolgert, nicht gemessen.
//!
//! **Warum Verwerfen richtig ist.** UDP verspricht keine Zustellung, und beide
//! Spuren sind darauf gebaut, dass Pakete unterwegs verlorengehen. Ein Bild-
//! paket liegt beim Scheitern schon im Speicher des NACK-Responders (webrtc-rs
//! `interceptor` 0.17.2, `nack/responder/responder_stream.rs`: `add` vor dem
//! Schreiben), der Zuschauer kann es also nachfordern wie jedes andere
//! verlorene Paket. Beim Ton tragen die folgenden Pakete den Rahmen als
//! RED-Kopie mit, wenn RED ausgehandelt ist ([`crate::ton`]); ohne RED fehlen
//! 10 ms Ton. Bis hierher war jeder dieser Fehler das Ende des Streams.
//!
//! **Warum ohne eigene Frist.** Nimmt das System dauerhaft nichts mehr an,
//! gehen auch die ICE-Prüfpakete nicht hinaus. Die Verbindung fällt dann über
//! den bestehenden Weg ([`crate::verbindung`], „Verbindung verloren“) — das ist
//! aus dem ICE-Ablauf gefolgert, für diesen Fehler nicht beobachtet. Eine
//! zweite, selbst erfundene Frist hier würde dieselbe Frage doppelt
//! beantworten.
//!
//! **Nur dieser eine Fehler.** Alles andere (geschlossene Verbindung,
//! abgebaute Spur) bricht weiter ab wie bisher. webrtc-rs reicht den
//! Socket-Fehler als Text durch (`flatten_errs` in
//! `track_local_static_rtp.rs` fasst die Fehler aller Bindungen zu einer
//! Zeichenkette zusammen), die Art des `io::Error` ist dabei verloren — erkannt
//! wird deshalb die Endung `(os error N)`, die Rust an jeden Betriebssystem-
//! Fehler hängt, unabhängig von der Sprache der Meldung davor.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use webrtc::rtp::packet::Packet;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;

/// `ENOBUFS` der jeweiligen Plattform.
#[cfg(windows)]
const PUFFER_VOLL: i32 = 10055; // WSAENOBUFS
#[cfg(target_os = "linux")]
const PUFFER_VOLL: i32 = 105;
#[cfg(target_os = "macos")]
const PUFFER_VOLL: i32 = 55;
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
const PUFFER_VOLL: i32 = i32::MIN;

/// Höchstens eine Meldezeile je Abstand — bei einem Schwall voller Puffer
/// schlüge sonst jedes Paket eine Zeile ins Protokoll.
const MELDE_ABSTAND: Duration = Duration::from_secs(1);

/// Welche Spur ein Paket verworfen hat — nur fürs Protokoll.
#[derive(Clone, Copy)]
pub enum Spur {
    Bild,
    Ton,
}

/// Verworfene Pakete im ganzen Prozess und der Zeitpunkt der letzten Meldung.
struct Stand {
    verworfen: u64,
    zuletzt_gemeldet: Option<Instant>,
}

static STAND: Mutex<Stand> = Mutex::new(Stand {
    verworfen: 0,
    zuletzt_gemeldet: None,
});

/// Ist das der Fehler „Sendepuffer des Systems voll“?
pub fn puffer_voll(fehler: &str) -> bool {
    fehler.contains(&format!("(os error {PUFFER_VOLL})"))
}

/// Ein Paket hinausschreiben; scheitert es nur am vollen Sendepuffer, wird es
/// verworfen und vermerkt, und das Ergebnis ist `Ok`. Jeder andere Fehler
/// kommt unverändert zurück.
pub async fn schreiben(
    track: &TrackLocalStaticRTP,
    paket: &Packet,
    spur: Spur,
) -> Result<(), webrtc::Error> {
    match track.write_rtp(paket).await {
        Ok(_) => Ok(()),
        Err(e) if puffer_voll(&e.to_string()) => {
            vermerken(spur, Instant::now());
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn vermerken(spur: Spur, jetzt: Instant) {
    let mut stand = STAND.lock().unwrap_or_else(|e| e.into_inner());
    stand.verworfen += 1;
    if stand
        .zuletzt_gemeldet
        .is_some_and(|t| jetzt.duration_since(t) < MELDE_ABSTAND)
    {
        return;
    }
    stand.zuletzt_gemeldet = Some(jetzt);
    let wo = match spur {
        Spur::Bild => "Bild",
        Spur::Ton => "Ton",
    };
    eprintln!(
        "[whip] Sendepuffer des Systems voll: {wo}paket verworfen \
         (insgesamt {}), der Strom läuft weiter",
        stand.verworfen
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Meldung aus dem Diagnose-Log vom 2026-11-06, wie sie webrtc-rs
    /// durchreicht — die deutsche Systemmeldung davor ist egal.
    #[cfg(windows)]
    #[test]
    fn erkennt_den_windows_befund() {
        assert!(puffer_voll(
            "io error: io error: Ein Socketvorgang konnte nicht ausgeführt werden, da dem \
             System Pufferspeicher fehlte oder eine Warteschlange voll war. (os error 10055)"
        ));
    }

    #[test]
    fn erkennt_die_eigene_plattform() {
        assert!(puffer_voll(&format!(
            "io error: irgendwas (os error {PUFFER_VOLL})"
        )));
    }

    /// Ein abgebauter oder fremder Fehler darf NICHT als Aussetzer durchgehen,
    /// sonst liefe ein toter Strom stumm weiter.
    #[test]
    fn andere_fehler_bleiben_fehler() {
        assert!(!puffer_voll("io: read/write on closed pipe"));
        assert!(!puffer_voll(
            "io error: Verbindung abgelehnt (os error 10061)"
        ));
        assert!(!puffer_voll("io error: connection refused (os error 111)"));
        // Eine Nummer, die die gesuchte nur als Endstück enthält.
        assert!(!puffer_voll(&format!("(os error 1{PUFFER_VOLL})")));
    }
}
