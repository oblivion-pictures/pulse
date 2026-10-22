//! Tonausgabe: Opus dekodieren, auf die Geraeterate bringen, ausgeben.
//!
//! Aufbau, und warum er so aussieht:
//!
//! * `cpal::Stream` ist auf mehreren Plattformen **nicht** `Send`. Er kann
//!   deshalb nicht in der Tokio-Sitzung liegen. Stattdessen laeuft die Ausgabe
//!   auf einem eigenen Thread, der den Stream besitzt; gefuettert wird ueber
//!   einen Kanal.
//! * Zwischen Decode und Geraete-Callback liegt ein Ringpuffer. Der Callback
//!   darf nicht blockieren und nicht allokieren — er kopiert nur heraus und
//!   fuellt bei Unterlauf Stille auf.
//! * `av_offset_ms` wird als Ziel-Fuellstand des Rings umgesetzt: mehr Puffer
//!   heisst spaeterer Ton. Das ist der NUTZ-Trim; darueber liegt seit der
//!   Lippen-Synchronisation der Regel-Eingriff aus [`lippen`], der den
//!   Soll-Fuellstand nachfuehrt — seit dem 2026-10-22 gegen das gezeigte Bild
//!   in der Uhr der Sender Reports ([`bildbezug`], die gemeinsame Uhr mit dem
//!   Videopfad), ohne solche Messung wie vorher gegen die Ton-RTP-Uhr.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(target_os = "linux")]
use anyhow::Context as _;
use anyhow::Result;

mod ausgabe_cpal;
#[cfg(target_os = "linux")]
mod ausgabe_pipewire;
mod bildbezug;
mod fuetterung;
mod lippen;
mod nachzuegler;
mod opus;
mod ringregelung;
#[cfg(test)]
mod tests;
mod uhrenabgleich;
mod verdeckung;
mod zaehler;

use fuetterung::pump_commands;
use nachzuegler::Nachzuegler;
#[cfg(test)]
use opus::OpusDecoder;
#[cfg(test)]
use ringregelung::im_rueckstand;
use ringregelung::{Ringregelung, RING_BODEN_MS, RING_RUECKSTAND_MS, RING_SOLL_MS};
use uhrenabgleich::Uhrenabgleich;
pub use zaehler::AudioCounters;

/// Wie viel Ton der Ring hoechstens vorhaelt. Laeuft die Wiedergabe davon,
/// ist er ohnehin verloren — dann lieber verwerfen als Speicher fressen.
///
/// Bewusst als ZEIT und nicht als feste Samplezahl: `av_offset_ms` darf bis
/// 2000 ms Vorlauf verlangen, und der Zielfuellstand skaliert mit Rate und
/// Kanalzahl des Geraets. Eine feste Zahl fuer 48 kHz Stereo lag darunter,
/// sobald ein Mehrkanal- oder Hochraten-Geraet im Spiel war — der Ring wurde
/// dann unter den Zielfuellstand gekappt, der Callback gab nie etwas aus und
/// es blieb dauerhaft still, ohne Meldung.
const MAX_RING_SECONDS: usize = 6;

/// Steuerbefehle an den Ausgabe-Thread.
enum AudioCommand {
    Pcm(Vec<f32>, Option<u32>),
    /// Rohes Opus-Paket samt RTP-Zeitstempel (48-k-Takte, fuer die
    /// Lippen-Vermessung, s. [`lippen`]). Dekodiert und umgerechnet wird es
    /// auf DIESEM Thread, nicht beim Aufrufer — der Aufrufer ist die
    /// Sitzungsschleife, die auch die Bilder bearbeitet.
    ///
    /// Gemessen am 2026-07-26 (144-fps-Stream, 1440p10): mit Ton entstanden
    /// 42-44 Aussetzer je Sekunde mit Luecken bis 24 ms, ohne Ton NULL und der
    /// groesste Abstand lag bei 11 ms. Die 44 entsprachen dem Opus-Takt (ein
    /// Paket je 20 ms) — jedes Paket hielt die Bildverarbeitung an, solange es
    /// dekodiert und von 48000 auf die Geraeterate umgerechnet wurde.
    Packet(Vec<u8>, Option<u32>),
    Volume(f32),
    OffsetMs(i32),
    /// Bild/Ton-Versatz in der Uhr der Sender Reports und wann er gemessen
    /// wurde (s. [`bildbezug`]).
    BildTon(f64, Instant),
    Stop,
}

struct Shared {
    ring: VecDeque<f32>,
    volume: f32,
    /// Gewuenschter Fuellstand in Samples, bevor ausgegeben wird.
    /// = `RING_SOLL_MS` plus der Nutzer-Trim `av_offset_ms`.
    target_fill: usize,
    underruns: u64,
    dropped: u64,
    /// Verspaeteten Ton nach einem Unterlauf verwerfen (s. [`nachzuegler`]).
    nachzuegler: Nachzuegler,
    /// Notausgang fuer grobe Ausreisser (s. [`ringregelung`]). Die laufende
    /// Regelung macht der [`Uhrenabgleich`].
    regelung: Ringregelung,
    /// Nachfuehrung der Abspielrate gegen die Senderuhr (s. [`uhrenabgleich`]).
    /// **Das** ist die Regelung; `regelung` daneben faengt nur noch ab, was sie
    /// nicht mehr einholen kann.
    abgleich: Uhrenabgleich,
    /// Die Ausgabe wartet auf den Sollfuellstand, bevor sie (wieder) anlaeuft.
    ///
    /// **Warum das ein Zustand sein muss und keine Bedingung je Aufruf.** Bis
    /// zum 2026-08-07 stand in [`fill_output`] schlicht
    /// `if ring.len() < target_fill { Stille }`. Gemeint war der Anlauf, gewirkt
    /// hat es bei JEDEM Geraete-Aufruf: fiel der Ring einmal unter die 60 ms des
    /// Sollwerts, schwieg die Ausgabe, bis die vollen 60 ms wieder beisammen
    /// waren — bei 10-ms-Aufrufen also rund sechs stille Runden nach jeder
    /// Schwankung. Aus einer Delle von 20 ms wurde so ein hoerbarer Aussetzer,
    /// und `underruns` zaehlte davon **nichts**, weil der frueh verlassene Zweig
    /// am Zaehler vorbeiging. Die Kennzahl, an der dieser Weg beurteilt wird,
    /// mass den haeufigsten Fall nicht mit.
    ///
    /// Jetzt greift die Sperre nur, wenn der Ring wirklich leerlief — dann ist
    /// erneutes Vorfuellen richtig, weil sofortiges Weiterspielen mit ein paar
    /// Millisekunden Vorrat nur den naechsten Unterlauf holt.
    anlauf: bool,
    /// Solange der Ausgabe-Thread laeuft. Faellt er weg (vergiftete Sperre,
    /// Geraetefehler), meldete die Statistik sonst weiter "Ton aktiv",
    /// waehrend nichts mehr ankommt.
    alive: bool,
    /// Das Ausgabegeraet hat einen Fehler gemeldet — Kopfhoerer abgezogen,
    /// USB-Ton abgesteckt, Geraet verschwunden.
    ///
    /// **Warum das ein Zustand sein muss und keine Log-Zeile.** Der
    /// Fehler-Rueckruf von cpal schrieb bis 2026-08-13 nur ein `eprintln!`.
    /// Der Ausgabe-Thread laeuft danach WEITER (`alive` bleibt wahr), der Ring
    /// fuellt sich, der Geraete-Rueckruf kommt aber nie wieder — der Ton war
    /// fuer den Rest der Sitzung stumm, und die Anzeige meldete unveraendert
    /// "laeuft". Ein Ausfall, den niemand sieht, ist der schlimmere Ausfall.
    geraetefehler: bool,
    /// Verschraenkte Samples, die das Geraet bisher AUSGEGEBEN hat — auch
    /// Stille zaehlt, denn auch Stille ist verstrichene Kling-Zeit. Die
    /// Lippen-Vermessung rechnet daraus, welche RTP-Position gerade klingt.
    ausgabe: u64,
    /// Vermessung gegen die Ton-RTP-Uhr (s. [`lippen`]), ab dem ersten Paket.
    tonuhr: Option<lippen::Tonuhr>,
    /// Zuletzt vermessen: welche Ton-RTP-Marke klang, und wann
    /// (s. [`crate::bildton`]).
    klingt: Option<(u32, Instant)>,
    /// Nutz-Trim `av_offset_ms` — positively = Ton spaeter (s. `OffsetMs`).
    trim_ms: i32,
    /// Regel-Eingriff der Lippen-Synchronisation auf den Ring-Sollwert. Als
    /// Fliesskommazahl, weil der Schritt JE PAKET (dt = 20 ms) Bruchteile
    /// eines ms betraegt — eine ganze Zahl wuerde jeden Schritt zu null
    /// truncieren und der Eingriff bliebe fuer immer stehen (E2E-Lauf
    /// 2026-09-27: 8 Minuten +68 ms Fehler, Eingriff reglos bei +0).
    sync_ms: f32,
    /// Zuletzt gemessener Lippenfehler (positiv = Ton haengt hinterher),
    /// fuer die Statistik-Zeile.
    letzte_fehler_ms: f64,
    /// Zuletzt gemeldeter Bild/Ton-Versatz und wann er gemessen wurde
    /// (`AudioCommand::BildTon`, s. [`bildbezug`]).
    bildton: Option<(f64, Instant)>,
    /// Woran zuletzt geregelt wurde — fuer die Logzeile beim Wechsel.
    bezug: Option<bildbezug::Bezug>,
    /// Wann der Regel-Eingriff zuletzt fortgeschrieben wurde — fuer den
    /// Zeitschritt und um nach Stillpausen nicht mit altem Fehler zu regeln.
    letzte_nachfuehr: Option<Instant>,
    /// Samples je Millisekunde ueber alle Kanaele und die Sollwert-Grenze —
    /// beides gebraucht, um den Sollwert aus Trim + Eingriff neu zu setzen.
    per_ms: usize,
    max_ziel: usize,
    /// Abruftakt des Geraets und Zaehler der Verlust-Verdeckung (s. [`verdeckung`]).
    verdeckung: verdeckung::Stand,
}

impl Shared {
    /// Ring nach dem Anhaengen auf den Sollwert zurueckfuehren. Der harte
    /// Deckel darueber (`max_ring_samples`) ist ein Notausgang, keine Regelung
    /// — die steht in [`ringregelung`].
    ///
    /// `kanaele` muss die Kanalzahl des Ausgabegeraets sein: der Ring haelt
    /// verschraenktes PCM, und die Regelung darf nur ganze Frames abbauen.
    fn zurueckfuehren(&mut self) {
        let schwelle = self.kapp_schwelle();
        let geschnitten =
            self.regelung.nach_anhaengen(&mut self.ring, self.target_fill, schwelle, Instant::now());
        if geschnitten > 0 {
            // Der Schnitt beginnt einen neuen Abschnitt — ein Mittel ueber den
            // alten ist keine Beobachtung mehr (s. `neu_beginnen`).
            self.abgleich.neu_beginnen();
        }
        self.dropped += geschnitten;
    }

    /// Ab welchem Fuellstand die Grobkappung schneidet: Sollwert OHNE den
    /// Lippen-Eingriff plus [`RING_RUECKSTAND_MS`] (Begruendung dort).
    ///
    /// **Ausser im Nachlauf (unten) nie unter dem wirksamen Sollwert plus
    /// Rueckstand** — und auch dort immer ueber dem Sollwert. Ein positiver
    /// Eingriff (bis +150 ms) hebt den Sollwert ueber den Grundwert; ohne das
    /// `max` laege die Schwelle dann unter ihm, der Ring stuende im
    /// Regelbetrieb dauernd „im Rueckstand", der Lippen-Regler waere
    /// eingefroren, und ein Fuellstand zwischen Schwelle und Sollwert liesse
    /// den Schnitt unterlaufen (Nachpruefung 2026-10-14, gerechnet).
    ///
    /// Kurz nach einem (Wieder-)Anlauf tiefer: wirksamer Sollwert plus 30 ms
    /// (Begruendung an `nachzuegler::NACHLAUF`).
    fn kapp_schwelle(&self) -> usize {
        let grund = (RING_SOLL_MS + self.trim_ms.max(0) as usize) * self.per_ms;
        let normal = grund.max(self.target_fill) + RING_RUECKSTAND_MS * self.per_ms;
        self.nachzuegler.kappschwelle(normal, self.target_fill, self.per_ms, Instant::now())
    }

    /// Ring-Sollwert aus Nutz-Trim und Lippen-Eingriff neu setzen.
    ///
    /// **Untergrenze [`RING_BODEN_MS`]** (bis 2026-10-14: 1 ms, Begruendung
    /// dort). Und der Eingriff wird mit auf die Untergrenze zurueckgenommen,
    /// statt nur den Sollwert zu begrenzen: sonst integrierte der Regler weiter
    /// bis an seinen Deckel (-150 ms), obwohl davon nichts mehr wirkt — und
    /// braeuchte, wenn der Fehler kippt, Minuten, um den Ueberhang wieder
    /// abzubauen, bevor sich am Sollwert ueberhaupt etwas bewegt.
    fn ziel_setzen(&mut self) {
        let ohne_eingriff = RING_SOLL_MS as f32 + self.trim_ms.max(0) as f32;
        self.sync_ms = self.sync_ms.max(RING_BODEN_MS as f32 - ohne_eingriff);
        let basis_ms = ohne_eingriff + self.sync_ms;
        self.target_fill = (basis_ms.round() as usize * self.per_ms).min(self.max_ziel);
    }
}

/// Geraete-Callback. Laeuft im Echtzeit-Kontext: nicht blockieren, nicht
/// allokieren — nur aus dem Ring kopieren und bei Unterlauf Stille auffuellen.
fn fill_output(shared: &Mutex<Shared>, out: &mut [f32]) {
    let Ok(mut s) = shared.lock() else {
        out.fill(0.0);
        return;
    };
    // Verstrichene Kling-Zeit zaehlt IMMER, auch Stille im Anlauf und im
    // Unterlauf — sonst stünde die Lippen-Vermessung still, genau wenn der
    // Puffer leerlaeuft und der Fehler am groessten waere.
    s.ausgabe += out.len() as u64;
    s.verdeckung.abruf(out.len(), Instant::now());
    // Erst anlaufen lassen, wenn der Zielfuellstand da ist — sonst startet die
    // Wiedergabe direkt mit Unterlauf. Das gilt beim Start und nach einem
    // leergelaufenen Ring, NICHT bei jeder Delle darunter (s. [`Shared::anlauf`]).
    if s.anlauf {
        if s.ring.len() < s.target_fill {
            out.fill(0.0);
            // Vorfuellen heisst: dem Geraet kommt nichts. Das gehoert gezaehlt,
            // sonst ist es genau die Sorte stiller Eingriff, die hier behoben wird.
            s.underruns += 1;
            return;
        }
        s.anlauf = false;
    }
    let volume = s.volume;
    let written = s.ring.len().min(out.len());
    for (slot, v) in out.iter_mut().zip(s.ring.drain(..written)) {
        *slot = (v * volume).clamp(-1.0, 1.0);
    }
    out[written..].fill(0.0);
    if written < out.len() {
        s.underruns += 1;
        // Der Ring ist jetzt leer — erst wieder vorfuellen, statt die naechsten
        // Aufrufe einzeln hungern zu lassen.
        s.anlauf = true;
    }
}


/// Griff auf die laufende Ausgabe. Beim Fallenlassen endet der Thread.
pub struct AudioOutput {
    tx: Sender<AudioCommand>,
    shared: Arc<Mutex<Shared>>,
    pub sample_rate: u32,
    pub channels: u16,
    /// Verzoegerung vom Geraete-Abruf bis zum Lautsprecher in Mikrosekunden,
    /// wie die Anbindung sie meldet; 0 = noch keine Meldung. Neben `shared`,
    /// damit der Echtzeit-Rueckruf dafuer keine zweite Sperre nimmt.
    latenz_us: Arc<AtomicU32>,
    /// Ueber welchen Weg der Ton hinausgeht ("PipeWire", "ALSA", "WASAPI" …).
    pub weg: &'static str,
}

/// Abtastrate von Opus. Der Codec kennt nur diese eine — alles andere
/// entsteht erst durch Umrechnen beim Ausgeben.
const OPUS_SAMPLE_RATE: u32 = 48_000;

/// Zustand und Befehlskanal einer frisch geoeffneten Ausgabe — gemeinsam fuer
/// beide Geraete-Anbindungen (cpal, PipeWire).
fn zustand(
    sample_rate: u32,
    channels: u16,
) -> (Arc<Mutex<Shared>>, Sender<AudioCommand>, Receiver<AudioCommand>) {
    // VOR dem Anlegen von `Shared`: der Sollfuellstand haengt daran, und ihn
    // erst spaeter zu setzen hiesse, dass die Wiedergabe bis zum ersten
    // `OffsetMs` ungeregelt liefe — also im Regelfall fuer immer, weil die
    // Oberflaeche den Trim nur schickt, wenn jemand ihn anfasst.
    let per_ms = (sample_rate as usize * channels as usize) / 1000;

    let shared = Arc::new(Mutex::new(Shared {
        // Volle Kapazitaet im Voraus: sonst allokiert der Fuetter-Thread
        // beim Wachsen des Rings, waehrend er die Sperre haelt, auf die der
        // Geraete-Callback wartet. Das ist die klassische
        // Prioritaetsumkehr und aeussert sich als Knacksen.
        ring: VecDeque::new(),
        volume: 1.0,
        target_fill: RING_SOLL_MS * per_ms,
        underruns: 0,
        dropped: 0,
        nachzuegler: Nachzuegler::default(),
        regelung: Ringregelung::default(),
        abgleich: Uhrenabgleich::default(),
        anlauf: true,
        alive: true,
        geraetefehler: false,
        ausgabe: 0,
        klingt: None,
        tonuhr: None,
        trim_ms: 0,
        sync_ms: 0.0,
        letzte_fehler_ms: 0.0,
        bildton: None,
        bezug: None,
        letzte_nachfuehr: None,
        per_ms,
        max_ziel: max_ring_samples(sample_rate, channels) / 2,
        verdeckung: Default::default(),
    }));
    let (tx, rx) = std::sync::mpsc::channel::<AudioCommand>();
    // Volle Kapazitaet im Voraus: sonst allokiert der Fuetter-Thread beim
    // Wachsen des Rings, waehrend er die Sperre haelt, auf die der
    // Geraete-Callback wartet — Prioritaetsumkehr, hoerbar als Knacksen.
    if let Ok(mut s) = shared.lock() {
        s.ring.reserve(max_ring_samples(sample_rate, channels));
    }
    (shared, tx, rx)
}

fn max_ring_samples(sample_rate: u32, channels: u16) -> usize {
    MAX_RING_SECONDS * sample_rate as usize * channels as usize
}

/// Die Fuetterschleife bis `Stop` — auf dem Thread, der die Befehle annimmt.
/// Egal warum sie endet: danach kommt nichts mehr an.
fn fuettern(rx: &Receiver<AudioCommand>, shared: &Mutex<Shared>, sample_rate: u32, channels: u16) {
    let per_ms = (sample_rate as usize * channels as usize) / 1000;
    let max_ring = max_ring_samples(sample_rate, channels);
    pump_commands(rx, shared, per_ms, max_ring, sample_rate, channels);
    if let Ok(mut s) = shared.lock() {
        s.alive = false;
    }
}

impl AudioOutput {
    /// Oeffnet die Tonausgabe: unter Linux zuerst direkt ueber PipeWire
    /// (s. [`ausgabe_pipewire`]), sonst und als Rueckfall ueber cpal. Schlaegt
    /// beides fehl, ist das kein Grund, die Sitzung zu beenden — der Aufrufer
    /// laeuft dann stumm weiter.
    pub fn new() -> Result<Self> {
        #[cfg(target_os = "linux")]
        if ausgabe_pipewire::gewuenscht() {
            match Self::ueber_pipewire() {
                Ok(out) => return Ok(out),
                Err(e) => eprintln!(
                    "pulse-player: PipeWire-Ausgabe nicht moeglich ({e:#}) — weiter ueber cpal"
                ),
            }
        }
        let (device, config, weg) = ausgabe_cpal::oeffnen()?;
        let (sample_rate, channels) = (config.sample_rate, config.channels);
        let (shared, tx, rx) = zustand(sample_rate, channels);
        let latenz_us = Arc::new(AtomicU32::new(0));
        ausgabe_cpal::starten(device, config, Arc::clone(&shared), rx, Arc::clone(&latenz_us))?;
        Ok(Self { tx, shared, sample_rate, channels, latenz_us, weg })
    }

    /// Direkt ueber PipeWire: immer 48 kHz Stereo — umgerechnet und verteilt
    /// wird im PipeWire-Graphen, der Opus-Decoder gibt unveraendert weiter.
    #[cfg(target_os = "linux")]
    fn ueber_pipewire() -> Result<Self> {
        let (sample_rate, channels) = (OPUS_SAMPLE_RATE, ausgabe_pipewire::KANAELE);
        let (shared, tx, rx) = zustand(sample_rate, channels);
        let latenz_us = Arc::new(AtomicU32::new(0));
        let griff = ausgabe_pipewire::starten(Arc::clone(&shared), Arc::clone(&latenz_us))?;
        let faden_shared = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("pulse-player-audio".into())
            .spawn(move || {
                fuettern(&rx, &faden_shared, sample_rate, channels);
                // Erst jetzt den PipeWire-Faden beenden: bis `Stop` ruft er
                // die Ausgabe ab.
                drop(griff);
            })
            .context("Audio-Thread liess sich nicht starten")?;
        Ok(Self { tx, shared, sample_rate, channels, latenz_us, weg: "PipeWire" })
    }

    /// Rohes Opus-Paket zur Wiedergabe geben, samt RTP-Zeitstempel (48-k-Takte)
    /// fuer die Lippen-Vermessung (s. [`lippen`]). Ohne Zeitstempel spielt der
    /// Ton weiter — nur die Synchronisation ruht dann. Kehrt sofort zurueck —
    /// Dekodieren und Umrechnen passieren auf dem Ton-Thread.
    pub fn push_packet(&self, packet: &[u8], rtp_ts: Option<u32>) {
        if packet.is_empty() {
            return;
        }
        let _ = self.tx.send(AudioCommand::Packet(packet.to_vec(), rtp_ts));
    }

    pub fn set_volume(&self, v: f32) {
        let _ = self.tx.send(AudioCommand::Volume(v.clamp(0.0, 4.0)));
    }

    pub fn set_offset_ms(&self, ms: i32) {
        let _ = self.tx.send(AudioCommand::OffsetMs(ms.clamp(-2000, 2000)));
    }

    /// Den zuletzt gemessenen Bild/Ton-Versatz melden (+ = Ton hinkt). Solange
    /// er frisch ist, regelt die Lippen-Synchronisation gegen IHN statt gegen
    /// die eigene Ankunft des Tons — die gemeinsame Uhr mit dem Bild.
    pub fn bildton(&self, versatz_ms: f64, gemessen: Instant) {
        let _ = self.tx.send(AudioCommand::BildTon(versatz_ms, gemessen));
    }

    /// Zaehlerstaende fuer die Statistik. Bei vergifteter Sperre gilt die
    /// Ausgabe als tot (`alive: false` aus [`AudioCounters::default`]) — dann
    /// stimmt nichts mehr, und das soll man sehen.
    pub fn counters(&self) -> AudioCounters {
        self.shared
            .lock()
            .map(|s| AudioCounters {
                underruns: s.underruns,
                dropped: s.dropped,
                verspaetet: s.nachzuegler.verworfen,
                buffered: s.ring.len(),
                resyncs: s.regelung.resyncs,
                abgleich_ppm: s.abgleich.letzte_ppm,
                alive: s.alive,
                geraetefehler: s.geraetefehler,
                lippen_ms: s.letzte_fehler_ms as f32,
                klingt: s.klingt,
                sync_versatz_ms: s.sync_ms.round() as i32,
                verdeckung: s.verdeckung.zaehler,
                ausgabe_ms: match self.latenz_us.load(Ordering::Relaxed) {
                    0 => None,
                    us => Some(us as f32 / 1000.0),
                },
                weg: self.weg,
            })
            .unwrap_or_default()
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        let _ = self.tx.send(AudioCommand::Stop);
    }
}

