//! Senderberichte (RTCP SR) in der Zeit der [`Aufnahmeuhr`] — tritt an die
//! Stelle des `SenderReport`-Interceptors von webrtc-rs.
//!
//! **Was anders ist als dort** (interceptor 0.17.2, `report/sender/`):
//!
//! * Die RTP-Marke eines Berichts ist die, die eine JETZT aufgenommene Probe
//!   truege ([`Aufnahmeuhr::marke_jetzt`]) — nicht die des zuletzt
//!   geschriebenen Pakets plus verstrichene Zeit. Dadurch bilden Bild und Ton
//!   dieselbe Aufnahmezeit auf dieselbe Wanduhr ab (Begruendung im Kopf von
//!   [`crate::aufnahmeuhr`]).
//! * Der erste Bericht einer Spur geht VOR ihrem ersten Paket hinaus. MediaMTX
//!   verwirft mit `useAbsoluteTimestamp` jedes Paket, fuer das es noch keinen
//!   Bericht kennt (`to_stream.go`, „received RTP packet without absolute
//!   time"); ohne den fruehen Bericht ginge die erste Sekunde samt Vollbild
//!   verloren. Ob er dort wirklich vor dem Paket verarbeitet wird, haengt an
//!   den Lesefaeden des Servers — gemessen ist es nicht; die naechsten
//!   Berichte kommen deshalb in der ersten Sekunde dichter ([`ANLAUF`]).
//!
//! **Was gleich bleibt:** NTP-Teil = Wanduhr beim Absenden, Paket- und
//! Oktettzaehler je Spur. Die Laufzeitmessung `crate::stau` liest LSR/DLSR
//! der Empfaengerberichte und braucht genau diesen NTP-Teil.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use webrtc::interceptor::stream_info::StreamInfo;
use webrtc::interceptor::{
    Attributes, Error, Interceptor, InterceptorBuilder, RTCPReader, RTCPWriter, RTPReader,
    RTPWriter,
};
use webrtc::rtcp::sender_report::SenderReport;
use webrtc::rtp::extension::abs_send_time_extension::unix2ntp;

use crate::aufnahmeuhr::{Aufnahmeuhr, Spur};

/// Abstand der Berichte im Lauf — wie webrtc-rs und MediaMTX (1 s).
const INTERVALL: Duration = Duration::from_secs(1);
/// In der ersten Sekunde einer Verbindung kommen die Berichte so dicht, damit
/// ein Server, der den ersten verpasst hat, nicht eine volle Sekunde wartet.
const ANLAUF: Duration = Duration::from_millis(100);
const ANLAUF_DAUER: Duration = Duration::from_secs(1);

/// Baut den Interceptor fuer die Registry (`sdp::baue_api_mit_settings`).
pub struct SenderberichtBauer {
    pub uhr: Arc<Aufnahmeuhr>,
}

impl InterceptorBuilder for SenderberichtBauer {
    fn build(&self, _id: &str) -> Result<Arc<dyn Interceptor + Send + Sync>, Error> {
        Ok(Arc::new(Senderbericht {
            intern: Arc::new(Intern {
                uhr: Arc::clone(&self.uhr),
                stroeme: Mutex::new(HashMap::new()),
                rtcp: Mutex::new(None),
            }),
            takt: Mutex::new(None),
        }))
    }
}

/// Zaehler einer gebundenen Spur.
#[derive(Default)]
struct Zaehler {
    pakete: u32,
    oktette: u32,
    berichtet: bool,
}

struct Strom {
    ssrc: u32,
    spur: Spur,
    zaehler: Mutex<Zaehler>,
}

struct Intern {
    uhr: Arc<Aufnahmeuhr>,
    stroeme: Mutex<HashMap<u32, Arc<Strom>>>,
    rtcp: Mutex<Option<Arc<dyn RTCPWriter + Send + Sync>>>,
}

/// Der eigentliche Bericht — rein, damit er ohne Verbindung pruefbar ist.
fn bericht(
    uhr: &Aufnahmeuhr,
    strom: &Strom,
    wand: SystemTime,
    jetzt: Instant,
) -> Option<SenderReport> {
    let rtp_time = uhr.marke_jetzt(strom.spur, jetzt)?;
    let z = strom.zaehler.lock().unwrap_or_else(|e| e.into_inner());
    Some(SenderReport {
        ssrc: strom.ssrc,
        ntp_time: unix2ntp(wand),
        rtp_time,
        packet_count: z.pakete,
        octet_count: z.oktette,
        ..Default::default()
    })
}

impl Intern {
    fn schreiber(&self) -> Option<Arc<dyn RTCPWriter + Send + Sync>> {
        self.rtcp.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Je Spur ein eigenes RTCP-Paket, nicht einen Verbund fuer alle: ein
    /// Empfaenger mit webrtc-rs (der Player auf dem Direktweg) stellt einen
    /// Verbund nur der Spur zu, deren SSRC vorn steht — die zweite Spur saehe
    /// ihren Bericht nie (gemessen im Schleifentest, `senderbericht_tests.rs`).
    /// webrtc-rs selbst schreibt ebenfalls einzeln.
    async fn melden(&self, stroeme: &[Arc<Strom>]) {
        let Some(w) = self.schreiber() else { return };
        // Wanduhr und monotone Uhr im selben Augenblick lesen: die eine ist
        // der NTP-Teil, die andere rechnet die Marke.
        let (wand, jetzt) = (SystemTime::now(), Instant::now());
        for sr in stroeme.iter().filter_map(|s| bericht(&self.uhr, s, wand, jetzt)) {
            // Ein Fehler hier ist ein abgerissener Transport; das meldet die
            // Verbindung selbst, und der naechste Takt versucht es wieder.
            let _ = w.write(&[Box::new(sr)], &Attributes::new()).await;
        }
    }

    fn alle(&self) -> Vec<Arc<Strom>> {
        self.stroeme.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect()
    }
}

pub struct Senderbericht {
    intern: Arc<Intern>,
    takt: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Der Schreiber, der zwischen Spur und Transport sitzt.
struct Zaehlend {
    intern: Arc<Intern>,
    strom: Arc<Strom>,
    weiter: Arc<dyn RTPWriter + Send + Sync>,
}

#[async_trait]
impl RTPWriter for Zaehlend {
    async fn write(
        &self,
        pkt: &webrtc::rtp::packet::Packet,
        a: &Attributes,
    ) -> Result<usize, Error> {
        self.intern.uhr.paket(self.strom.spur, pkt.header.timestamp, Instant::now());
        let erster = {
            let mut z = self.strom.zaehler.lock().unwrap_or_else(|e| e.into_inner());
            z.pakete = z.pakete.wrapping_add(1);
            z.oktette = z.oktette.wrapping_add(pkt.payload.len() as u32);
            !std::mem::replace(&mut z.berichtet, true)
        };
        if erster {
            // VOR dem Paket (s. Modulkopf). Die Zaehler stehen schon auf eins:
            // der Bericht beschreibt den Stand, mit dem dieses Paket hinausgeht.
            self.intern.melden(std::slice::from_ref(&self.strom)).await;
        }
        self.weiter.write(pkt, a).await
    }
}

#[async_trait]
impl Interceptor for Senderbericht {
    async fn bind_rtcp_reader(
        &self,
        reader: Arc<dyn RTCPReader + Send + Sync>,
    ) -> Arc<dyn RTCPReader + Send + Sync> {
        reader
    }

    async fn bind_rtcp_writer(
        &self,
        writer: Arc<dyn RTCPWriter + Send + Sync>,
    ) -> Arc<dyn RTCPWriter + Send + Sync> {
        *self.intern.rtcp.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&writer));
        let intern = Arc::clone(&self.intern);
        let griff = tokio::spawn(async move {
            let start = Instant::now();
            loop {
                let abstand = if start.elapsed() < ANLAUF_DAUER { ANLAUF } else { INTERVALL };
                tokio::time::sleep(abstand).await;
                let stroeme = intern.alle();
                intern.melden(&stroeme).await;
            }
        });
        if let Some(alt) = self.takt.lock().unwrap_or_else(|e| e.into_inner()).replace(griff) {
            alt.abort();
        }
        writer
    }

    async fn bind_local_stream(
        &self,
        info: &StreamInfo,
        writer: Arc<dyn RTPWriter + Send + Sync>,
    ) -> Arc<dyn RTPWriter + Send + Sync> {
        // Eine Spur, deren Marke nicht am pts haengt, bekommt keinen Bericht
        // (s. Kopf von `aufnahmeuhr`) — dann besser keiner als ein falscher.
        let Some(spur) = Spur::aus_takt(info.clock_rate) else { return writer };
        let strom = Arc::new(Strom { ssrc: info.ssrc, spur, zaehler: Mutex::default() });
        // Ein Spurtausch (Opus → RED, `ton::TonSpur::nach_aushandlung`) bindet
        // dieselbe SSRC neu; der Eintrag wird ersetzt, die Zaehler beginnen neu.
        self.intern
            .stroeme
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(info.ssrc, Arc::clone(&strom));
        Arc::new(Zaehlend { intern: Arc::clone(&self.intern), strom, weiter: writer })
    }

    async fn unbind_local_stream(&self, info: &StreamInfo) {
        self.intern.stroeme.lock().unwrap_or_else(|e| e.into_inner()).remove(&info.ssrc);
    }

    async fn bind_remote_stream(
        &self,
        _info: &StreamInfo,
        reader: Arc<dyn RTPReader + Send + Sync>,
    ) -> Arc<dyn RTPReader + Send + Sync> {
        reader
    }

    async fn unbind_remote_stream(&self, _info: &StreamInfo) {}

    async fn close(&self) -> Result<(), Error> {
        if let Some(griff) = self.takt.lock().unwrap_or_else(|e| e.into_inner()).take() {
            griff.abort();
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "senderbericht_tests.rs"]
mod schleife_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn strom(spur: Spur, pakete: u32) -> Strom {
        Strom {
            ssrc: 7,
            spur,
            zaehler: Mutex::new(Zaehler { pakete, oktette: pakete * 100, berichtet: true }),
        }
    }

    /// Zwei Berichte desselben Augenblicks: Bild und Ton nennen dieselbe
    /// Wanduhr und die Marken derselben Aufnahmezeit — der ganze Zweck.
    #[test]
    fn bild_und_ton_berichten_dieselbe_aufnahmezeit() {
        let uhr = Aufnahmeuhr::default();
        uhr.ton_basis_setzen(5_000);
        let t0 = Instant::now();
        uhr.paket(Spur::Bild, 0, t0);
        let wand = SystemTime::now();
        let jetzt = t0 + Duration::from_millis(500);
        let b = bericht(&uhr, &strom(Spur::Bild, 3), wand, jetzt).unwrap();
        let t = bericht(&uhr, &strom(Spur::Ton, 9), wand, jetzt).unwrap();
        assert_eq!(b.ntp_time, t.ntp_time);
        assert_eq!(b.rtp_time, 45_000);
        assert_eq!(t.rtp_time, 5_000 + 24_000);
        assert_eq!((b.packet_count, t.octet_count), (3, 900));
    }

    /// Vor dem ersten Paket der Verbindung gibt es nichts abzubilden.
    #[test]
    fn vor_dem_ersten_paket_kein_bericht() {
        let uhr = Aufnahmeuhr::default();
        assert!(bericht(&uhr, &strom(Spur::Bild, 0), SystemTime::now(), Instant::now()).is_none());
    }
}
