//! Buchführung der WASAPI-Aufnahme ohne Windows-Bezug: wann ein Chunk hinaus
//! darf (Wanduhr-Budget, Drift-Drop, Stille-Füllung, Gerätelücke) und welche
//! AUFNAHMEZEIT sein erstes Sample hat.
//!
//! **Warum die Aufnahmezeit je Chunk.** Bis 0.1.139 trug jeder Chunk nur den
//! Geräte-Stempel des ERSTEN je gelesenen Samples (`CapturedAudio::qpc`, für
//! jeden Chunk derselbe). Damit ließ sich der Ton nur über gezählte Samples
//! stempeln — und die laufen der Wanduhr um alles davon, was das Budget in
//! `wasapi.rs` zulässt (bis 100 ms Vorlauf) und was die Verankerung beim Start
//! mitbringt. Gemessen am 2026-10-27 (Sender-Log `[sync]`, all3media): der
//! Ton-pts lag bei der Übergabe 12–30 ms in der ZUKUNFT, der Bild-pts 21 ms in
//! der Vergangenheit. 0.1.130 hatte schon einmal „Aufnahmezeit minus pts“
//! gerechnet, aber mit dem STEHENDEN Erst-Stempel — der Versatz fiel um 1 s je
//! Sekunde (Bughunt 2026-10-22, `intern/docs/wissen/hq-streaming.md`). Der
//! Test `versatz_tests::versatz_bleibt_ueber_eine_stunde_beschraenkt` fängt
//! genau diesen Fehler.
//!
//! **Wie.** WASAPI stempelt je Lesevorgang das ERSTE Frame des Pakets
//! (`BufferInfo.timestamp`, QPC in 100 ns). Pakete landen in einer Byte-Queue,
//! Chunks werden in fester Größe abgeschnitten — Paket- und Chunkgrenzen
//! fallen nicht zusammen. Deshalb führt das Buch je Paket eine Marke
//! (Position im Eingangsstrom, Stempel) und rechnet für einen Chunk vom
//! JÜNGSTEN Paket, das in ihm beginnt (oder vor ihm), mit der Nennrate auf
//! sein erstes Frame zurück. Vom jüngsten, nicht vom ältesten: bleibt nach dem
//! Ende eines Tons ein Rest unter Chunkgröße in der Queue liegen (Desktop
//! verstummt, Stille-Füllung übernimmt), wird er erst mit dem nächsten Ton
//! hinausgegeben — direkt davor gespielt. Vom alten Paket aus gerechnet trüge
//! der Chunk einen Stempel von vor der ganzen Stille; vom neuen aus steht er
//! dort, wo er tatsächlich klingt. Liegen beide Pakete lückenlos hintereinander,
//! ergeben beide Wege dasselbe bis auf die Abweichung der Gerätequarze über
//! ein Paket (Mikrosekunden).

use std::collections::VecDeque;

/// Einheiten von QPC-Stempeln je Sekunde (WASAPI und WGC rechnen in 100 ns).
const QPC_HZ: i128 = 10_000_000;

/// Obergrenze für das Auffüllen einer Gerätelücke (2 s bei 48 kHz).
pub const MAX_LUECKE_FRAMES: u64 = 96_000;

/// Aufnahmezeit des ersten Samples eines Chunks auf der QPC-Achse (100 ns).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aufnahmezeit {
    /// Aus dem Geräte-Stempel eines Lesevorgangs zurückgerechnet.
    Geraet(u64),
    /// Stille-Füllung: kein Gerätestempel, s. [`Aufnahmebuch::schritt`].
    Stille(u64),
    /// Kein brauchbarer Stempel (noch keine gültige Marke).
    Unbekannt,
}

impl Aufnahmezeit {
    pub fn qpc(self) -> Option<u64> {
        match self {
            Self::Geraet(q) | Self::Stille(q) => Some(q),
            Self::Unbekannt => None,
        }
    }
}

/// Was ein Lesevorgang über den Gerätestrom verrät.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Luecke {
    Keine,
    /// So viele Frames Stille gehören VOR die gerade gelesenen Daten
    /// (Begründung an `wasapi::fuelle_geraetelucke`).
    Aufgefuellt(u64),
    /// Sprung zu groß für eine Lücke (Geräte-Neustart?) — nicht aufgefüllt.
    ZuGross(u64),
}

/// Was die Aufnahme als Nächstes tun soll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Schritt {
    /// Einen Chunk aus der Queue hinausgeben. `vorher` = bis dahin emittierte
    /// Frames (für die Sonde).
    Echt { zeit: Aufnahmezeit, vorher: u64 },
    /// Einen Chunk aus der Queue verwerfen (Ton läuft > 100 ms vor der Wanduhr).
    Verwerfen,
    /// Einen Chunk Stille hinausgeben (gegenüber der Wanduhr fehlt ein ganzer).
    Stille { zeit: Aufnahmezeit, vorher: u64 },
    /// Nichts zu tun, bis neue Daten kommen.
    Warten,
}

#[derive(Debug, Clone, Copy)]
struct Marke {
    /// Position des Frames im Eingangsstrom der Queue (Lückenfüllung zählt mit).
    frame: u64,
    qpc: u64,
}

/// Spiegel der Byte-Queue in Frames, samt Stempel-Marken und Budget.
///
/// Invariante, die `wasapi.rs` einhält: die Queue enthält genau
/// [`gepuffert`](Self::gepuffert) Frames; jedes `Echt`/`Verwerfen` nimmt einen
/// Chunk heraus, jedes `gelesen` legt Lücke + Daten hinein.
pub struct Aufnahmebuch {
    rate: u32,
    chunk: u64,
    /// Vorlauf-Budget für die Drift-Korrektur, ~100 ms (s. `wasapi.rs`).
    vorlauf_grenze: u64,
    /// ALLE emittierten Frames (echt + Stille) — die Bilanz gegen die Wanduhr.
    emittiert: u64,
    eingang: u64,
    ausgang: u64,
    marken: VecDeque<Marke>,
    /// Erwarteter Geräte-Frame-Index des nächsten Lesevorgangs.
    naechster_index: Option<u64>,
    /// QPC des ersten je gelesenen Samples (alte Bedeutung von
    /// `CapturedAudio::qpc`, Verankerung des gezählten pts).
    erster_qpc: u64,
    /// Bezug für Stille-Stempel: (Aufnahmezeit, emittierte Frames an ihr).
    stille_bezug: (u64, u64),
}

impl Aufnahmebuch {
    /// `start_qpc` = QPC des Moments, ab dem die Wanduhr-Bilanz zählt.
    pub fn neu(rate: u32, chunk_frames: usize, start_qpc: u64) -> Self {
        Self {
            rate: rate.max(1),
            chunk: chunk_frames as u64,
            vorlauf_grenze: u64::from(rate / 10),
            emittiert: 0,
            eingang: 0,
            ausgang: 0,
            marken: VecDeque::new(),
            naechster_index: None,
            erster_qpc: 0,
            stille_bezug: (start_qpc, 0),
        }
    }

    /// Frames, die gerade in der Queue liegen.
    pub fn gepuffert(&self) -> u64 {
        self.eingang - self.ausgang
    }

    /// QPC des ersten je gelesenen Samples; `0`, bis ein Read passiert ist.
    pub fn erster_qpc(&self) -> u64 {
        self.erster_qpc
    }

    /// Ein Lesevorgang: Geräte-Index des ersten Frames, Anzahl Frames, sein
    /// Stempel. `stempel_gueltig = false` bei `AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR`
    /// — dann keine Marke, die Nachbarn tragen den Chunk.
    pub fn gelesen(&mut self, index: u64, frames: u64, qpc: u64, stempel_gueltig: bool) -> Luecke {
        if self.erster_qpc == 0 {
            self.erster_qpc = qpc;
        }
        let erwartet = *self.naechster_index.get_or_insert(index);
        let luecke = match index.checked_sub(erwartet) {
            Some(f) if f > 0 && f <= MAX_LUECKE_FRAMES => Luecke::Aufgefuellt(f),
            Some(f) if f > 0 => Luecke::ZuGross(f),
            _ => Luecke::Keine,
        };
        let fuellung = match luecke {
            Luecke::Aufgefuellt(f) => f,
            _ => 0,
        };
        if frames > 0 && stempel_gueltig && qpc != 0 {
            self.marken.push_back(Marke { frame: self.eingang + fuellung, qpc });
        }
        self.eingang += fuellung + frames;
        self.naechster_index = Some(index + frames);
        luecke
    }

    /// Entscheidet den nächsten Schritt gegen die Wanduhr-Bilanz `faellig`
    /// (Frames, die seit dem Start fällig sind) und bucht ihn.
    ///
    /// **Stille-Stempel.** Stille hat keinen Gerätestempel. Sie bekommt die
    /// Aufnahmezeit, an der sie im hinausgegebenen Strom STEHT: fortgeschrieben
    /// vom letzten Chunk mit Gerätestempel um die seither emittierten Frames,
    /// vor dem ersten davon ab dem Start (= Wanduhr-Fälligkeit auf der
    /// QPC-Achse). Warum fortgeschrieben statt immer die Fälligkeit: der
    /// Gerätestempel liegt um die Latenz des Geräts neben dem Budget-Fahrplan;
    /// mit der Fälligkeit spränge die Ton-Marke bei jedem Übergang Ton↔Stille
    /// um diesen Betrag (nach vorn = Lücke beim Zuschauer, nach hinten = die
    /// Marke steht, `pulse_whip::ton::marke`). Fortgeschrieben bleibt der
    /// Versatz zur Zählung über die Stille stehen. Beschränkt bleibt er so oder
    /// so: Stille wird nur nach der Wanduhr eingefügt, der Fahrplan läuft also
    /// mit ihr.
    pub fn schritt(&mut self, faellig: u64) -> Schritt {
        if self.gepuffert() >= self.chunk {
            if self.emittiert > faellig + self.vorlauf_grenze {
                self.entnehmen();
                return Schritt::Verwerfen;
            }
            let zeit = self.entnehmen().map_or(Aufnahmezeit::Unbekannt, Aufnahmezeit::Geraet);
            if let Aufnahmezeit::Geraet(q) = zeit {
                self.stille_bezug = (q, self.emittiert);
            }
            let vorher = self.emittiert;
            self.emittiert += self.chunk;
            return Schritt::Echt { zeit, vorher };
        }
        if self.emittiert + self.chunk <= faellig {
            let (basis, bei) = self.stille_bezug;
            let zeit = Aufnahmezeit::Stille(self.qpc_plus_frames(basis, self.emittiert - bei));
            let vorher = self.emittiert;
            self.emittiert += self.chunk;
            return Schritt::Stille { zeit, vorher };
        }
        Schritt::Warten
    }

    /// Nimmt einen Chunk heraus und liefert den Stempel seines ersten Frames
    /// (Rückrechnung vom jüngsten Paket, das vor seinem Ende beginnt — s.
    /// Modulkopf).
    fn entnehmen(&mut self) -> Option<u64> {
        let anfang = self.ausgang;
        let ende = anfang + self.chunk;
        let zeit = self.marken.iter().rev().find(|m| m.frame < ende).and_then(|m| {
            let frames = i128::from(m.frame) - i128::from(anfang);
            let q = i128::from(m.qpc) - frames * QPC_HZ / i128::from(self.rate);
            u64::try_from(q).ok().filter(|&q| q != 0)
        });
        self.ausgang = ende;
        // Für spätere Chunks zählt nur die jüngste Marke, die schon vor dem
        // Ausgang liegt, plus alle danach.
        while self.marken.len() >= 2 && self.marken[1].frame <= self.ausgang {
            self.marken.pop_front();
        }
        zeit
    }

    fn qpc_plus_frames(&self, qpc: u64, frames: u64) -> u64 {
        qpc + (u128::from(frames) * QPC_HZ as u128 / u128::from(self.rate)) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const CHUNK: usize = 480;
    /// 10 ms in QPC-Einheiten.
    const ZEHN_MS: u64 = 100_000;

    fn echt(s: Schritt) -> Aufnahmezeit {
        match s {
            Schritt::Echt { zeit, .. } => zeit,
            andere => panic!("Echt erwartet, war {andere:?}"),
        }
    }

    /// Pakete, die nicht auf Chunkgrenzen fallen: jeder Chunk trägt den
    /// Stempel SEINES ersten Frames, nicht den des ersten Pakets.
    #[test]
    fn chunk_stempel_zwischen_paketgrenzen() {
        let mut b = Aufnahmebuch::neu(RATE, CHUNK, 1_000_000);
        // Pakete à 300 Frames (6,25 ms = 62 500 QPC) ab QPC 5 000 000.
        for k in 0..8u64 {
            b.gelesen(k * 300, 300, 5_000_000 + k * 62_500, true);
        }
        // Chunk 0 beginnt bei Frame 0, Chunk 1 bei Frame 480 (= 10 ms).
        assert_eq!(echt(b.schritt(10_000)), Aufnahmezeit::Geraet(5_000_000));
        assert_eq!(echt(b.schritt(10_000)), Aufnahmezeit::Geraet(5_000_000 + ZEHN_MS));
        assert_eq!(echt(b.schritt(10_000)), Aufnahmezeit::Geraet(5_000_000 + 2 * ZEHN_MS));
    }

    /// Eine Gerätelücke steht VOR den neuen Daten; ihre Stille bekommt die
    /// Zeit, die real verstrich (Rückrechnung vom Stempel des neuen Pakets).
    #[test]
    fn geraetelucke_wird_aufgefuellt_und_gestempelt() {
        let mut b = Aufnahmebuch::neu(RATE, CHUNK, 0);
        assert_eq!(b.gelesen(0, 480, 2_000_000, true), Luecke::Keine);
        assert_eq!(b.gelesen(480 + 960, 480, 2_000_000 + 3 * ZEHN_MS, true), Luecke::Aufgefuellt(960));
        assert_eq!(b.gepuffert(), 480 * 4);
        let zeiten: Vec<_> = (0..4).map(|_| echt(b.schritt(1_000_000))).collect();
        let soll: Vec<_> = (0..4).map(|k| Aufnahmezeit::Geraet(2_000_000 + k * ZEHN_MS)).collect();
        assert_eq!(zeiten, soll);
        assert_eq!(b.gelesen(10_000_000, 480, 9, true), Luecke::ZuGross(10_000_000 - 1920));
    }

    /// Ein Rest unter Chunkgröße, der eine Stille überdauert, wird vom NEUEN
    /// Paket aus gestempelt — dort klingt er.
    #[test]
    fn rest_nach_stille_steht_beim_neuen_ton() {
        let mut b = Aufnahmebuch::neu(RATE, CHUNK, 0);
        b.gelesen(0, 600, 1_000_000, true);
        assert_eq!(echt(b.schritt(480)), Aufnahmezeit::Geraet(1_000_000));
        // 120 Frames Rest. Neuer Ton 5 s später.
        b.gelesen(600, 480, 51_000_000, true);
        let rest = 120 * 10_000_000 / 48_000;
        assert_eq!(echt(b.schritt(1_000_000)), Aufnahmezeit::Geraet(51_000_000 - rest));
    }

    /// Stille vor jedem Gerätestempel: Wanduhr-Fälligkeit ab dem Start; danach
    /// fortgeschrieben vom letzten Gerätestempel.
    #[test]
    fn stille_stempel_faelligkeit_dann_fortgeschrieben() {
        let mut b = Aufnahmebuch::neu(RATE, CHUNK, 7_000_000);
        assert_eq!(b.schritt(479), Schritt::Warten);
        assert_eq!(b.schritt(480), Schritt::Stille { zeit: Aufnahmezeit::Stille(7_000_000), vorher: 0 });
        assert_eq!(b.schritt(960), Schritt::Stille { zeit: Aufnahmezeit::Stille(7_000_000 + ZEHN_MS), vorher: 480 });
        b.gelesen(0, 480, 7_150_000, true);
        assert_eq!(echt(b.schritt(1440)), Aufnahmezeit::Geraet(7_150_000));
        assert_eq!(b.schritt(2400), Schritt::Stille { zeit: Aufnahmezeit::Stille(7_250_000), vorher: 1440 });
    }

    /// Fehler-Flag am Stempel: keine Marke, der Chunk rechnet vom Nachbarn.
    #[test]
    fn stempelfehler_nimmt_den_nachbarn() {
        let mut b = Aufnahmebuch::neu(RATE, CHUNK, 0);
        b.gelesen(0, 480, 3_000_000, true);
        b.gelesen(480, 480, 123, false);
        echt(b.schritt(10_000));
        assert_eq!(echt(b.schritt(10_000)), Aufnahmezeit::Geraet(3_000_000 + ZEHN_MS));
        let mut leer = Aufnahmebuch::neu(RATE, CHUNK, 0);
        leer.gelesen(0, 480, 0, true);
        assert_eq!(echt(leer.schritt(10_000)), Aufnahmezeit::Unbekannt);
    }

    /// Vorlauf über 100 ms: verwerfen, und die Marken bleiben stimmig.
    #[test]
    fn vorlauf_verwirft_und_haelt_die_marken() {
        let mut b = Aufnahmebuch::neu(RATE, CHUNK, 0);
        for k in 0..20u64 {
            b.gelesen(k * 480, 480, 4_000_000 + k * ZEHN_MS, true);
        }
        // Fällig ist nichts — die ersten 10 Chunks (100 ms) gehen, dann Drop.
        for _ in 0..11 {
            assert!(matches!(b.schritt(0), Schritt::Echt { .. }));
        }
        assert_eq!(b.schritt(0), Schritt::Verwerfen);
        assert_eq!(echt(b.schritt(100_000)), Aufnahmezeit::Geraet(4_000_000 + 12 * ZEHN_MS));
    }
}
