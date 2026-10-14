//! Strecke Sender → Server: wie viele Pakete der SERVER vermisst — je Spur,
//! aus seinen RTCP-Empfängerberichten.
//!
//! **Warum es das gibt (2026-10-14).** Bei Tonaussetzern war nicht zu sagen,
//! ob die Pakete auf dem Weg vom Sender zum Server oder vom Server zum
//! Zuschauer verlorengingen. Der Player misst nur seine eigene Strecke (und
//! kann nicht zurückrechnen: MediaMTX nummeriert die Bildpakete neu), der
//! Sender loggte gar keine Verlustzahl. Dabei hatte er sie die ganze Zeit in
//! der Hand: MediaMTX schickt ihm je Spur Empfängerberichte (Receiver
//! Reports), und die wurden gelesen und verworfen — beim Ton sogar ganz
//! ungesehen (`while audio_sender.read(..).is_ok() {}`).
//!
//! **Woher die Zahlen kommen — am Quelltext nachgelesen, nicht gemessen**
//! (MediaMTX 1.19.1, gortsplib v5.6.0, pion/webrtc v4.2.15):
//!
//! * `internal/protocols/webrtc/inbound_track.go::start` legt für JEDE
//!   eingehende Spur einen `rtpreceiver.Receiver` an (`Period: 1 * time.Second`,
//!   `WritePacketRTCP` → `t.writeRTCP`, also zurück an uns) — ohne
//!   Unterscheidung nach Art. **Der Ton bekommt also ebenso Berichte wie das
//!   Bild**, sofern überhaupt Tonpakete ankommen: die `InboundTrack` entsteht
//!   erst mit dem ersten Paket der Spur (`GatherInboundTracks`). Eine stumme
//!   Tonspur erscheint deshalb hier als „keine Rückmeldung", nicht als
//!   „0 verloren". Die Pulse-Patches 0002–0008 lassen den Bericht-Weg
//!   unberührt (sie setzen nur `BufferSize`, s. u.).
//! * `pion`s eigener Bericht-Interceptor ist dort AUS (`registerInterceptors`:
//!   „skip ConfigureRTCPReports") — gortsplib ist die einzige Quelle, und es
//!   schickt je Bericht genau EINEN Block, den für unsere SSRC.
//! * `total_lost` ist bei gortsplib `min(lost, 0xFFFFFF)` und kann nicht
//!   sinken. **„Verloren" heißt dort: der Umordnungspuffer hat auf das Paket
//!   nicht länger gewartet** (`reorder`, Zweig „buffer is full"). Ein per NACK
//!   rechtzeitig nachgeliefertes Bildpaket zählt also NICHT; ein Tonpaket, das
//!   später kommt als das Fenster lang ist (Patch 0008 verkleinert es auf
//!   Wunsch auf 4 Pakete = 40 ms), zählt dagegen als verloren, obwohl es noch
//!   ankam. Genau die Sicht, die für Aussetzer zählt — aber keine reine
//!   Leitungszahl.
//! * Jitter: RFC-3550-Schätzer in RTP-Takten, über die Ankunftszeit je Paket.
//!   **Für das Bild ist er keine reine Netzzahl**: alle Pakete eines Bildes
//!   tragen denselben Zeitstempel, und unser Taktgeber (`pacer`) verteilt sie
//!   absichtlich über den Bildabstand — diese Verteilung steckt mit drin
//!   (gefolgert aus dem Rechenweg, nicht gemessen). Beim Ton (ein Paket je
//!   Zeitstempel) misst er die Leitung.
//! * NACKs (`TransportLayerNack`) erzeugt pions Generator in MediaMTX nur für
//!   das Bild (nur dort steht `nack` im Angebot, `sdp.rs`), alle 100 ms erneut
//!   für jedes noch fehlende Paket und ohne Obergrenze
//!   (`maxNacksPerPacket: 0`). „Nachforderungen" zählt daher angeforderte
//!   Pakete EINSCHLIESSLICH Wiederholungen — ein Maß für Unruhe auf der
//!   Strecke, keine zweite Verlustzahl.
//!
//! **Was diese Datei NICHT tut.** Sie entscheidet nichts und meldet kein
//! Ereignis — sie macht eine Zeile fürs Log (`sidecar.log`, Diagnose-Upload).
//! Ins Log geht sie höchstens alle [`ZEILEN_ABSTAND`]; tritt Verlust auf,
//! früher, aber nie öfter als alle [`VERLUST_ABSTAND`]. Je Sekunde eine Zeile
//! wäre über eine Stream-Stunde 3600 Zeilen, die den 512-KiB-Ausschnitt des
//! Diagnose-Uploads füllen (`desktop/electron/sidecar-log-noise.ts`).
//!
//! **Direktpfad bewusst ohne diese Zeile.** Dort ist der Empfänger der Player
//! selbst, und der misst genau diese eine Strecke schon — die Frage „welcher
//! Abschnitt" stellt sich ohne Server nicht.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use webrtc::rtcp::packet::Packet;
use webrtc::rtcp::receiver_report::ReceiverReport;
use webrtc::rtcp::reception_report::ReceptionReport;
use webrtc::rtcp::transport_feedbacks::transport_layer_nack::TransportLayerNack;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;

/// Regeltakt der Zeile — auch ohne Verlust, damit „0 verloren" belegt ist.
pub const ZEILEN_ABSTAND: Duration = Duration::from_secs(10);
/// Mindestabstand, wenn Verlust auftrat (sonst die Regel-Zeile abwarten).
pub const VERLUST_ABSTAND: Duration = Duration::from_secs(1);

/// RTP-Uhr der Tonspur (Opus, `sdp::opus_capability`).
const TON_TAKT_HZ: u32 = 48_000;

/// Welche Spur ein RTCP-Paket betrifft — bestimmt der Aufrufer: webrtc-rs
/// verteilt RTCP nach Ziel-SSRC auf die Sender (`webrtc-srtp`,
/// `session::destination_ssrc`), der Leser des Bild-Senders sieht also nur
/// Berichte über das Bild.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Spur {
    Bild,
    Ton,
}

impl Spur {
    fn takt_hz(self) -> u32 {
        match self {
            Spur::Bild => crate::av1::RTP_TAKT_HZ,
            Spur::Ton => TON_TAKT_HZ,
        }
    }
}

/// `total_lost` ist laut RFC 3550 eine VORZEICHENBEHAFTETE 24-bit-Zahl (durch
/// Duplikate kann das Netto negativ werden); webrtc-rs liefert die 24 Bit
/// unverändert als `u32`. gortsplib schickt nie Negatives, ein anderer Server
/// darf es.
fn total_lost_i32(roh: u32) -> i32 {
    // Bit 23 nach oben schieben, dann arithmetisch zurück: Vorzeichen-Erweiterung.
    ((roh << 8) as i32) >> 8
}

/// Der zuletzt gemeldete Zählerstand — Basis für den nächsten Zuwachs.
#[derive(Clone, Copy)]
struct Stand {
    ssrc: u32,
    verloren: i32,
    hoechste_seq: u32,
}

/// Eine Spur, gezählt seit der letzten Zeile.
#[derive(Default)]
struct SpurZaehler {
    stand: Option<Stand>,
    berichte: u32,
    verloren: u64,
    /// Nur Zuwächse ZWISCHEN zwei Berichten: beim ersten fehlt die
    /// Ausgangsnummer, aus der sich „erwartet" ergäbe.
    anteil_verloren: u64,
    anteil_erwartet: u64,
    jitter_max_takte: u32,
    nachforderungen: u64,
}

impl SpurZaehler {
    fn bericht(&mut self, r: &ReceptionReport) {
        let neu = Stand {
            ssrc: r.ssrc,
            verloren: total_lost_i32(r.total_lost),
            hoechste_seq: r.last_sequence_number,
        };
        match self.stand {
            // Fremde SSRC: nicht unsere Spur (ein Bericht mit mehreren
            // Blöcken ginge an jeden Sender, den er nennt). Ignorieren, die
            // Basis bleibt.
            Some(alt) if alt.ssrc != neu.ssrc => return,
            Some(alt) => {
                let dv = i64::from(neu.verloren) - i64::from(alt.verloren);
                // Erweiterte Nummer (Zyklen << 16 | Nummer): Differenz mit
                // Überlauf über die 32 Bit hinweg.
                let de = neu.hoechste_seq.wrapping_sub(alt.hoechste_seq) as i32;
                // Rückgang des Zählers oder der Nummer: der Server hat neu
                // angefangen (oder Duplikate verrechnet) — kein Zuwachs, nur
                // die neue Basis. Lieber eine Lücke als ein erfundener Verlust.
                if dv >= 0 && de >= 0 {
                    self.verloren += dv as u64;
                    self.anteil_verloren += dv as u64;
                    self.anteil_erwartet += de as u64;
                }
            }
            // Erster Bericht: der Zähler läuft „seit Empfangsbeginn", also
            // gehört alles darin zu dieser Sitzung.
            None => self.verloren += neu.verloren.max(0) as u64,
        }
        self.stand = Some(neu);
        self.berichte += 1;
        self.jitter_max_takte = self.jitter_max_takte.max(r.jitter);
    }

    fn nack(&mut self, n: &TransportLayerNack) {
        // Je Paar das genannte Paket plus jedes gesetzte Bit der Maske.
        self.nachforderungen += n
            .nacks
            .iter()
            .map(|p| 1 + u64::from(p.lost_packets.count_ones()))
            .sum::<u64>();
    }

    /// Text für eine Spur; danach beginnt das nächste Intervall bei null.
    fn text(&mut self, spur: Spur) -> String {
        let name = match spur {
            Spur::Bild => "Bild",
            Spur::Ton => "Ton",
        };
        let Some(stand) = self.stand.filter(|_| self.berichte > 0) else {
            let n = std::mem::take(&mut self.nachforderungen);
            return match n {
                0 => format!("{name}: keine Rückmeldung"),
                n => format!("{name}: keine Rückmeldung, Nachforderungen +{n}"),
            };
        };
        let anteil = match self.anteil_erwartet {
            0 => "–".to_owned(),
            e => format!("{} %", komma(self.anteil_verloren as f64 * 100.0 / e as f64)),
        };
        let jitter_ms = f64::from(self.jitter_max_takte) * 1000.0 / f64::from(spur.takt_hz());
        let nach = match spur {
            Spur::Bild => format!(", Nachforderungen +{}", self.nachforderungen),
            Spur::Ton => String::new(),
        };
        let text = format!(
            "{name}: verloren +{} (gesamt {}), Anteil {anteil}{nach}, Jitter bis {} ms",
            self.verloren,
            stand.verloren,
            komma(jitter_ms),
        );
        *self = SpurZaehler { stand: Some(stand), ..SpurZaehler::default() };
        text
    }
}

/// Eine Nachkommastelle, deutsches Komma.
fn komma(x: f64) -> String {
    format!("{x:.1}").replace('.', ",")
}

struct Zustand {
    bild: SpurZaehler,
    ton: SpurZaehler,
    letzte_zeile: Instant,
}

impl Zustand {
    fn spur(&mut self, spur: Spur) -> &mut SpurZaehler {
        match spur {
            Spur::Bild => &mut self.bild,
            Spur::Ton => &mut self.ton,
        }
    }

    fn pakete(&mut self, spur: Spur, pakete: &[Box<dyn Packet + Send + Sync>]) {
        for p in pakete {
            let any = p.as_any();
            if let Some(rr) = any.downcast_ref::<ReceiverReport>() {
                for r in &rr.reports {
                    self.spur(spur).bericht(r);
                }
            } else if let Some(n) = any.downcast_ref::<TransportLayerNack>() {
                self.spur(spur).nack(n);
            }
        }
    }

    /// Die Zeile, falls fällig — sonst `None`, und nichts wird zurückgesetzt.
    fn zeile(&mut self, jetzt: Instant) -> Option<String> {
        if self.bild.berichte + self.ton.berichte == 0 {
            // Noch nichts vom Server gehört (oder seit der letzten Zeile
            // nichts mehr): keine Zeile, die nur „keine Rückmeldung" sagt.
            return None;
        }
        let seit = jetzt.saturating_duration_since(self.letzte_zeile);
        let verlust = self.bild.verloren + self.ton.verloren > 0;
        if seit < ZEILEN_ABSTAND && !(verlust && seit >= VERLUST_ABSTAND) {
            return None;
        }
        self.letzte_zeile = jetzt;
        Some(format!(
            "Strecke zum Server ({} s) — {}; {}",
            komma(seit.as_secs_f64()),
            self.bild.text(Spur::Bild),
            self.ton.text(Spur::Ton),
        ))
    }
}

/// Die Verlust-Buchhaltung einer WHIP-Sitzung, geteilt zwischen den Lesern
/// des Bild- und des Ton-Senders.
pub struct Strecke {
    zustand: Mutex<Zustand>,
}

impl Strecke {
    pub fn neu() -> Arc<Self> {
        Self::neu_ab(Instant::now())
    }

    fn neu_ab(beginn: Instant) -> Arc<Self> {
        Arc::new(Self {
            zustand: Mutex::new(Zustand {
                bild: SpurZaehler::default(),
                ton: SpurZaehler::default(),
                letzte_zeile: beginn,
            }),
        })
    }

    /// Die RTCP-Pakete eines Lesevorgangs einordnen. Rückgabe: die Log-Zeile,
    /// wenn eine fällig ist — der Aufrufer setzt sie in SEINER Log-Sprache ab
    /// (Linux `tracing`, Windows/macOS `eprintln!`, s. `lib.rs`).
    pub fn rtcp(&self, spur: Spur, pakete: &[Box<dyn Packet + Send + Sync>]) -> Option<String> {
        self.rtcp_zu(spur, pakete, Instant::now())
    }

    fn rtcp_zu(
        &self,
        spur: Spur,
        pakete: &[Box<dyn Packet + Send + Sync>],
        jetzt: Instant,
    ) -> Option<String> {
        let mut z = self.zustand.lock().unwrap_or_else(|e| e.into_inner());
        z.pakete(spur, pakete);
        z.zeile(jetzt)
    }
}

/// Liest den Rückkanal des TON-Senders, bis die Verbindung weg ist, und
/// reicht jede fällige Zeile an `melde`.
///
/// Ersetzt das reine Leerlesen (`while audio_sender.read(..).is_ok() {}`).
/// Gelesen werden MUSS weiterhin — ungelesene Rückmeldungen stauen den
/// Sender —, und die Fehlerbehandlung ist die des Bild-Lesers in den
/// Sidecars: ein einzelner Lesefehler beendete die alte Schleife für immer
/// (dort am 2026-07-28 auf der Leitung als „nur EINE von zehn
/// Vollbild-Anforderungen kam an" gefunden); erst fünf am Stück heißen
/// „Verbindung weg".
pub async fn ton_rueckkanal(sender: Arc<RTCRtpSender>, strecke: Arc<Strecke>, melde: fn(&str)) {
    let mut fehler_am_stueck = 0u32;
    loop {
        match sender.read_rtcp().await {
            Ok((pakete, _)) => {
                fehler_am_stueck = 0;
                if let Some(zeile) = strecke.rtcp(Spur::Ton, &pakete) {
                    melde(&zeile);
                }
            }
            Err(_) => {
                fehler_am_stueck += 1;
                if fehler_am_stueck >= 5 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}

#[cfg(test)]
#[path = "strecke_tests.rs"]
mod tests;
