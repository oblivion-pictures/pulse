//! Verlorenen Ton verdecken, statt den Ring leerlaufen zu lassen.
//!
//! **Der Befund** (aus dem Code gefolgert, nicht gemessen): fehlt ein
//! Opus-Paket, haelt der Jitter-Puffer alles Folgende zurueck, bis die
//! Nachlieferung kommt oder seine Geduld (rund 90-100 ms) ablaeuft. Der Ring
//! haelt beim Grundwert aber nur rund 60 ms (`RING_SOLL_MS`, nach unten bis
//! `RING_BODEN_MS`). Er lief deshalb bei jedem verlorenen Paket leer, dessen
//! Nachlieferung nicht binnen dieses Vorrats kam: Stille, danach Vorfuellen
//! bis zum Sollwert, und der verspaetete Schwall fiel `nachzuegler` zum Opfer.
//!
//! **Was hier passiert.** Kurz bevor der Geraete-Rueckruf mehr verlangt, als
//! der Ring haelt, haengt der Fuetter-Faden Ersatzton an — Rahmen fuer Rahmen,
//! bis der naechste Abruf gedeckt ist. Kommt der echte Ton danach doch noch,
//! ist seine Zeit schon verdeckt: das Paket wird VOR dem Dekodieren verworfen
//! ([`Verdeckung::echtes_paket`]). Gerechnet (nicht gemessen): der Ring steht
//! danach wieder dort, wo er beim Verlust stand — verdeckt wird genau die Zeit,
//! die sonst Stille gewesen waere, und von dem Schwall bleibt nur, was danach
//! kommt. Keine zusaetzliche Latenz. Lippen- und Uhrenabgleich werden nur
//! von echten Paketen angestossen; deren Marken schliessen nahtlos an den
//! Ersatzton an (`Tonuhr::paket` rechnet mit dem Ring VOR dem Paket, und darin
//! steht der Ersatzton an genau seiner Stelle). Den Fuellstand, den beide
//! beobachten, hebt der Ersatzton natuerlich mit — genau wie der echte Ton,
//! an dessen Stelle er steht.
//!
//! **Grenze: Sendepause statt Verlust** (gerechnet, nicht gemessen). Schweigt
//! der Sender kuerzer als [`HOECHSTENS_TAKTE`] und springt seine Marke danach
//! vor (Aufnahme-Luecke, `whip_dauer`; DTX ist bei keinem Sender an), kommt
//! kein Schwall nach: der Ring steht danach bei etwa einem Abruf statt beim
//! Sollwert und wird nur vom Uhrenabgleich (rund 1 ms je Sekunde) wieder
//! angehoben. Bisher lief er dort leer und fuellte bis zum Sollwert vor (bis
//! 60 ms Stille). Dauert die Pause laenger, laeuft er nach dem Budget leer
//! wie bisher.
//!
//! **Woher der Ersatzton kommt** ([`super::opus::OpusDecoder::verdecken`]): ein
//! Opus-Paket aus nur dem TOC-Byte. Gemessen am 2026-10-15 (Test
//! `decoder_verdeckt_ueber_das_toc_paket`, FFmpeg 8.1 des Pruefbaus,
//! synthetisches Signal): libopus (Windows, macOS) setzt das Signal per PLC
//! fort und laesst es abklingen (RMS 0,23 vorher, Ersatz 0,23/0,18/0,12);
//! FFmpegs eigener Decoder `opus` klingt im ersten Ersatzrahmen aus (0,05)
//! und gibt danach Stille. Welcher wo laeuft: im Flatpak bis 0.1.110 nur
//! `opus` (das Manifest schaltete alle Decoder ab und nur `opus` wieder an),
//! seit 0.1.111 auch `libopus` (im lokalen Probebau des Manifests per
//! `avcodec_find_decoder_by_name` nachgesehen, 2026-10-15; bewacht von
//! `zwillinge/tests/flatpak_decoder.rs`). Windows nimmt das LGPL-Paket von BtbN
//! wie der Pruefbau, der den libopus-Decoder hat (das Windows-Zip selbst nicht
//! geoeffnet); macOS baut mit `--enable-libopus` ohne Decoder-Liste
//! (`mac-hq-sidecar/scripts/build-ffmpeg.sh`, daraus gefolgert). An beiden
//! Kanten kein Knack: der groesste Sprung zwischen zwei Samples lag bei
//! hoechstens 0,008 gegen 0,026 im Signal selbst. Liefert der Decoder gar
//! nichts, haengt [`luecke_fuellen`] Stille an — mit hartem Schnitt, aber immer noch besser als ein leerer Ring, der
//! danach erst wieder bis zum Sollwert vorfuellt.
//!
//! **In-Band-FEC (LBRR) nutzt das NICHT** — es ist ohne neue Abhaengigkeit
//! nicht erreichbar: FFmpegs libopus-Decoder kennt nur die Option
//! `apply_phase_inv` (`ffmpeg -h decoder=libopus`, nachgesehen), ruft libopus
//! also ohne `decode_fec` auf; dass FFmpegs eigener Decoder LBRR zwar liest,
//! aber verwirft, ist aus der Erinnerung an dessen Quelltext, hier nicht
//! nachgelesen. Dazu kommt: LBRR gibt es nur in SILK/Hybrid, und bei den
//! 128 kbit/s der Sender waehlt libopus ueberwiegend CELT (am synthetischen
//! Signal mit den Sender-Einstellungen 266 von 301 Paketen CELT-only, im Test
//! oben 45 von 80 — der Anfang laeuft Hybrid; am echten Strom nicht gezaehlt).
//!
//! **Wann nicht verdeckt wird**: vor dem ersten Paket, im Anlauf (Ring leer,
//! Ausgabe fuellt vor — dann ist der Unterlauf schon passiert, und
//! `nachzuegler` uebernimmt wie bisher), wenn ein Geraete-Abruf groesser als
//! der Sollwert ist, und nach [`HOECHSTENS_TAKTE`] am Stueck.
//!
//! **Ohne Verlust aendert sich nichts** (aus dem Code gefolgert): verdeckt
//! wird nur, wenn der naechste Abruf in [`VORLAUF`] faellig ist und der Ring
//! ihn nicht mehr deckt — also nur dort, wo bisher ein Unterlauf kam. Einzige
//! Ausnahme: ein Paket, das genau in diesen letzten Millisekunden noch
//! eingetroffen waere, wird jetzt durch einen Rahmen Ersatzton ersetzt.
//! Video beruehrt das nicht; die Datei arbeitet nur im Ton-Faden.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::opus::OpusDecoder;
use super::Shared;

/// So lange vor dem erwarteten Geraete-Abruf wird entschieden. Deckt das
/// Aufwachen des Fadens und einen PLC-Decode — angenommen, nicht gemessen
/// (Timer-Schlupf unter Linux liegt im Mikrosekundenbereich, unter Windows
/// stellt `main.rs` den Systemtimer per `timeBeginPeriod(1)` auf 1 ms; ein
/// Opus-Rahmen dekodiert weit unter einer Millisekunde). Zu klein heisst: der
/// Abruf kommt vorher, der Ring laeuft leer wie bisher. Zu gross heisst: ein
/// Paket, das in diesem Fenster noch gekommen waere, wird durch Ersatzton
/// ersetzt.
const VORLAUF: Duration = Duration::from_millis(3);

/// Laengste Wartezeit des Fuetter-Fadens ohne Befehl. Nur damit er nach einem
/// Anlauf oder ohne bekannten Abruftakt wieder nachsieht.
const LEERLAUF: Duration = Duration::from_millis(10);

/// Hoechstens so viel Ersatzton am Stueck, in 48-k-Takten (120 ms). Deckt die
/// Geduld des Jitter-Puffers (rund 100 ms) abzueglich des Ringvorrats mit
/// Abstand. Dauert es laenger (Sender schweigt, Leitung weg), laeuft der Ring
/// leer wie bisher: endloser Ersatzton haette nichts mehr zu verdecken.
pub(super) const HOECHSTENS_TAKTE: u32 = 120 * 48;

/// Zaehler fuer die Statistikzeile.
#[derive(Debug, Default, Clone, Copy)]
pub struct Zaehler {
    /// Verdeckte Rahmen (je einer Opus-Rahmendauer, im Strom 10 ms).
    pub verdeckt: u64,
    /// Davon per PLC des Decoders (libopus); der Rest ist Ausblenden/Stille.
    pub plc: u64,
    /// Echte Pakete, die nach dem Verdecken zu spaet kamen und verworfen
    /// wurden — so viele Nachlieferungen haetten einen groesseren Ring
    /// gebraucht.
    pub ersetzt: u64,
}

/// Was die Verdeckung vom Geraet und vom Ring wissen muss. Liegt in
/// `Shared`; `abruf` setzt der Geraete-Rueckruf.
#[derive(Default)]
pub(super) struct Stand {
    /// Groesse des letzten Geraete-Abrufs in verschraenkten Samples.
    abruf: usize,
    /// Wann er kam.
    abruf_zeit: Option<Instant>,
    pub(super) zaehler: Zaehler,
}

impl Stand {
    /// Vom Geraete-Rueckruf: ein Abruf ueber `samples` verschraenkte Samples.
    pub(super) fn abruf(&mut self, samples: usize, jetzt: Instant) {
        self.abruf = samples;
        self.abruf_zeit = Some(jetzt);
    }
}

/// Momentaufnahme fuer [`Verdeckung::entscheiden`].
pub(super) struct Lage {
    pub ring: usize,
    pub abruf: usize,
    pub abruf_zeit: Option<Instant>,
    pub soll: usize,
    /// Verschraenkte Samples je Millisekunde.
    pub per_ms: usize,
    pub anlauf: bool,
}

#[derive(Debug, PartialEq)]
pub(super) enum Schritt {
    /// Einen Rahmen verdecken; Inhalt = TOC-Byte des letzten echten Pakets.
    Verdecken(u8),
    Warten(Duration),
}

/// Zustand im Fuetter-Faden.
#[derive(Default)]
pub(super) struct Verdeckung {
    /// TOC-Byte des letzten echten Pakets — Rahmendauer und Betriebsart des
    /// Ersatztons.
    toc: Option<u8>,
    /// RTP-Marke, an der der Ring endet (echter oder Ersatzton).
    ende: Option<u32>,
    /// Ersatzton seit dem letzten echten Paket, in 48-k-Takten.
    lauf: u32,
    pub(super) zaehler: Zaehler,
}

impl Verdeckung {
    /// Ein echtes Paket kam. `false` = verwerfen: seine Zeit ist schon
    /// verdeckt. Ohne laufende Verdeckung immer `true`. Vermerkt wird ein
    /// behaltenes Paket erst nach dem Dekodieren ([`Self::angehaengt`]) —
    /// scheitert das, laege `ende` sonst hinter Ton, der nie im Ring ankam.
    ///
    /// Verworfen wird, wenn mindestens die Haelfte des Pakets im verdeckten
    /// Bereich liegt. Die Marken des Senders folgen der Aufnahmeuhr und
    /// springen nicht immer um genau eine Rahmendauer
    /// (`linux-hq-sidecar/encode/audio.rs::whip_dauer`); ein nur angeschnittenes
    /// Paket bleibt deshalb, statt Ton zu verlieren, der nie verdeckt war.
    pub(super) fn echtes_paket(&mut self, paket: &[u8], rtp: Option<u32>) -> bool {
        let Some(dauer) = takte(paket) else { return true };
        if let (Some(ende), Some(rtp), true) = (self.ende, rtp, self.lauf > 0) {
            // In i64: bei einem Bruch der Zeitbasis liegt der Abstand irgendwo
            // im ganzen i32-Bereich, und `* 2` liefe ueber.
            let ueberlapp = i64::from(ende.wrapping_sub(rtp) as i32);
            if ueberlapp * 2 >= i64::from(dauer) && ueberlapp <= i64::from(self.lauf + dauer) {
                self.zaehler.ersetzt += 1;
                return false;
            }
        }
        true
    }

    /// Ein echtes Paket ist dekodiert und geht in den Ring: Ersatzton-Lauf
    /// beendet, Ringende und Rahmenart von diesem Paket.
    pub(super) fn angehaengt(&mut self, paket: &[u8], rtp: Option<u32>) {
        let Some(dauer) = takte(paket) else { return };
        self.toc = paket.first().copied();
        self.ende = rtp.map(|r| r.wrapping_add(dauer));
        self.lauf = 0;
    }

    /// Jetzt verdecken oder wie lange warten. Rein, damit es ohne Geraet
    /// pruefbar ist.
    pub(super) fn entscheiden(&self, lage: &Lage, jetzt: Instant) -> Schritt {
        // Ohne RTP-Marke (`ende`) liesse sich spaeter eintreffender echter Ton
        // nicht als verdeckt erkennen — er klaenge doppelt. Dann lieber nicht.
        let (Some(toc), Some(_), Some(zeit)) = (self.toc, self.ende, lage.abruf_zeit) else {
            return Schritt::Warten(LEERLAUF);
        };
        let rahmen = rahmen_takte(toc);
        if lage.anlauf
            || lage.abruf == 0
            || lage.per_ms == 0
            || lage.abruf > lage.soll
            || self.lauf + rahmen > HOECHSTENS_TAKTE
        {
            return Schritt::Warten(LEERLAUF);
        }
        let periode = Duration::from_micros((lage.abruf * 1000 / lage.per_ms) as u64);
        // Entscheidungspunkt vor dem naechsten Abruf: letzter Abruf plus eine
        // Periode, abzueglich Vorlauf.
        let faellig = zeit + periode.saturating_sub(VORLAUF);
        if lage.ring >= lage.abruf {
            // Der naechste Abruf ist gedeckt; danach wieder nachsehen.
            let bis = faellig.saturating_duration_since(jetzt);
            let bis = if bis.is_zero() { periode } else { bis };
            return Schritt::Warten(bis.clamp(Duration::from_micros(500), LEERLAUF));
        }
        if jetzt >= faellig {
            return Schritt::Verdecken(toc);
        }
        Schritt::Warten((faellig - jetzt).clamp(Duration::from_micros(500), LEERLAUF))
    }

    /// Ein Rahmen Ersatzton wurde angehaengt.
    fn verdeckt(&mut self, toc: u8, per_plc: bool) {
        let rahmen = rahmen_takte(toc);
        self.lauf += rahmen;
        self.ende = self.ende.map(|e| e.wrapping_add(rahmen));
        self.zaehler.verdeckt += 1;
        self.zaehler.plc += u64::from(per_plc);
    }
}

/// Vor jedem Warten auf den naechsten Befehl: verdecken, solange der naechste
/// Abruf sonst leerliefe. Gibt zurueck, wie lange hoechstens auf einen Befehl
/// zu warten ist. Dekodiert wird ohne Sperre (Begruendung in `fuetterung`).
pub(super) fn luecke_fuellen(
    shared: &Mutex<Shared>,
    mut decoder: Option<&mut OpusDecoder>,
    v: &mut Verdeckung,
    rate: u32,
    kanaele: u16,
) -> Duration {
    loop {
        let schritt = {
            let Ok(mut s) = shared.lock() else { return LEERLAUF };
            s.verdeckung.zaehler = v.zaehler;
            let lage = Lage {
                ring: s.ring.len(),
                abruf: s.verdeckung.abruf,
                abruf_zeit: s.verdeckung.abruf_zeit,
                soll: s.target_fill,
                per_ms: s.per_ms,
                anlauf: s.anlauf,
            };
            v.entscheiden(&lage, Instant::now())
        };
        let toc = match schritt {
            Schritt::Warten(d) => return d,
            Schritt::Verdecken(toc) => toc,
        };
        let mit_plc = decoder.as_deref().is_some_and(OpusDecoder::mit_plc);
        let plc = decoder.as_deref_mut().and_then(|d| d.verdecken(toc));
        let per_plc = mit_plc && plc.is_some();
        let pcm = plc.unwrap_or_else(|| {
            let frames = (rahmen_takte(toc) as usize * rate as usize).div_ceil(48_000);
            vec![0.0; frames * usize::from(kanaele)]
        });
        let Ok(mut s) = shared.lock() else { return LEERLAUF };
        s.ring.extend(pcm);
        v.verdeckt(toc, per_plc);
        s.verdeckung.zaehler = v.zaehler;
    }
}

/// Dauer EINES Rahmens laut TOC-Byte in 48-k-Takten (RFC 6716 §3.1).
fn rahmen_takte(toc: u8) -> u32 {
    let config = toc >> 3;
    match config {
        // SILK: 10/20/40/60 ms
        0..=11 => [480, 960, 1920, 2880][usize::from(config % 4)],
        // Hybrid: 10/20 ms
        12..=15 => [480, 960][usize::from(config % 2)],
        // CELT: 2,5/5/10/20 ms
        _ => [120, 240, 480, 960][usize::from(config % 4)],
    }
}

/// Dauer eines ganzen Pakets in 48-k-Takten (RFC 6716 §3.2), `None` bei
/// einem Paket, das keine Dauer hergibt.
fn takte(paket: &[u8]) -> Option<u32> {
    let toc = *paket.first()?;
    let anzahl = match toc & 0x03 {
        0 => 1,
        1 | 2 => 2,
        _ => u32::from(*paket.get(1)? & 0x3F),
    };
    Some(rahmen_takte(toc) * anzahl).filter(|&t| t > 0)
}

#[cfg(test)]
mod tests;
