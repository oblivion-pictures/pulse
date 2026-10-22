//! Stau auf der Strecke Sender → Server, aus der Laufzeit hin und zurück.
//!
//! **Warum es das gibt (2026-10-21).** Die Warnung „Leitung eng" aus
//! [`crate::bandbreite`] wartet auf `goog-remb`, und MediaMTX schickt am
//! WHIP-Eingang keins: in 373 Sender-Berichten der Cloud (60 Tage) stand
//! nicht eine einzige REMB-Zeile, und im Quelltext (1.19.1,
//! `registerInterceptors`) wird kein REMB-Erzeuger angemeldet. Ob eine
//! Leitung zu eng war, ließ sich deshalb aus keinem Log ablesen.
//!
//! **Woher die Zahl kommt.** Die Empfängerberichte, die [`crate::strecke`]
//! ohnehin liest, tragen je Block den Zeitpunkt unseres letzten
//! Senderberichts (LSR) und wie lange der Server danach bis zu seinem Bericht
//! gewartet hat (DLSR). Laufzeit = jetzt − LSR − DLSR, alles im mittleren
//! 32-bit-Wort der NTP-Zeit (RFC 3550, Abschnitt 6.4.1). gortsplib füllt beide
//! Felder (`pkg/rtpreceiver/receiver.go:157`, v5.6.0), MediaMTX reicht ihm
//! unsere Senderberichte durch (`inbound_track.go`, `ProcessSenderReport`);
//! unsere Senderberichte tragen `unix2ntp(SystemTime::now())` beim Absenden
//! (seit 2026-10-22 aus `crate::senderbericht`, vorher ebenso aus
//! webrtc-rs' `report/sender/sender_stream.rs`) — [`ntp_mitte`] nimmt
//! dieselbe Uhr. Am Quelltext nachgelesen, nicht an der Leitung
//! gemessen.
//!
//! **Was „Stau" hier heißt.** Die kleinste Laufzeit der letzten
//! [`GRUNDWERT_FENSTER`] ist der Grundwert — so lange braucht die Leitung
//! ohne Warteschlange. Alles darüber ist Stau unterwegs. Grenzen, gefolgert,
//! nicht gemessen:
//!
//! * Die Laufzeit misst HIN UND ZURÜCK: ein Stau auf dem Rückweg (Server →
//!   Sender) zählt mit, obwohl er unseren Strom nicht bremst.
//! * Ein Bericht je Sekunde und Spur: kurze Spitzen fallen durch, gemessen
//!   wird anhaltender Stau — genau der, um den es bei einer zu engen Leitung
//!   geht.
//! * Hält ein Stau länger als das Fenster, wird er selbst zum Grundwert und
//!   verschwindet aus „Stau"; die Zeile nennt deshalb immer auch die
//!   Laufzeit selbst.
//!
//! **Nur fürs Log** (Eigentümer-Entscheid 2026-10-21): kein Ereignis an die
//! App, kein Hinweis an den Streamer, keine Änderung der Datenrate.

use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime};

/// Über diese Zeit wird der Grundwert (kleinste Laufzeit) gesucht.
pub(crate) const GRUNDWERT_FENSTER: Duration = Duration::from_secs(120);
/// Ab so viel Stau, mindestens [`ENG_DAUER`] am Stück: „Leitung eng".
pub(crate) const ENG_STAU: Duration = Duration::from_millis(100);
pub(crate) const ENG_DAUER: Duration = Duration::from_secs(3);
/// Unter so viel Stau ist eine enge Leitung wieder frei.
pub(crate) const FREI_STAU: Duration = Duration::from_millis(30);
/// Längere Laufzeiten gelten als Rechenfehler (Uhrsprung, fremder LSR).
const LAUFZEIT_MAX: Duration = Duration::from_secs(10);

/// 1/65536 s je Einheit des mittleren NTP-Worts.
const EINHEITEN_JE_SEKUNDE: u64 = 65_536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Meldung {
    Eng { laufzeit: Duration, stau: Duration },
    Frei { laufzeit: Duration, stau: Duration },
}

impl Meldung {
    pub(crate) fn text(&self) -> String {
        let (was, laufzeit, stau) = match *self {
            Meldung::Eng { laufzeit, stau } => ("Leitung eng (Stau)", laufzeit, stau),
            Meldung::Frei { laufzeit, stau } => ("Leitung wieder frei", laufzeit, stau),
        };
        format!("{was}: Laufzeit {} ms, {} ms über dem Grundwert", ms(laufzeit), ms(stau))
    }
}

/// Auf ganze Millisekunden gerundet: die NTP-Einheit (1/65536 s) trifft
/// eine ganze Millisekunde fast nie, abgeschnitten stünde 179 statt 180.
fn ms(d: Duration) -> u128 {
    (d.as_micros() + 500) / 1000
}

/// Laufzeit hin und zurück aus einem Berichtsblock; `None`, solange der
/// Server noch keinen Senderbericht von uns gesehen hat (LSR 0) oder wenn
/// das Ergebnis nicht plausibel ist.
pub(crate) fn laufzeit(lsr: u32, dlsr: u32, jetzt_mitte: u32) -> Option<Duration> {
    if lsr == 0 {
        return None;
    }
    let einheiten = u64::from(jetzt_mitte.wrapping_sub(lsr).wrapping_sub(dlsr));
    let rtt = Duration::from_nanos(einheiten * 1_000_000_000 / EINHEITEN_JE_SEKUNDE);
    (rtt <= LAUFZEIT_MAX).then_some(rtt)
}

/// Das mittlere 32-bit-Wort der NTP-Zeit — dieselbe Rechnung, mit der
/// webrtc-rs unsere Senderberichte stempelt (Modulkopf).
pub(crate) fn ntp_mitte(t: SystemTime) -> u32 {
    (webrtc::rtp::extension::abs_send_time_extension::unix2ntp(t) >> 16) as u32
}

/// Laufzeiten des Abschnitts seit der letzten Log-Zeile.
#[derive(Clone, Copy)]
struct Abschnitt {
    letzte: Duration,
    stau_max: Duration,
}

#[derive(Default)]
pub(crate) struct StauWacht {
    /// Laufzeiten im [`GRUNDWERT_FENSTER`], älteste vorn.
    proben: VecDeque<(Instant, Duration)>,
    eng: bool,
    /// Seit wann der Stau ununterbrochen über [`ENG_STAU`] liegt.
    ueber_seit: Option<Instant>,
    abschnitt: Option<Abschnitt>,
}

impl StauWacht {
    /// Eine Laufzeit einordnen. Eine Meldung nur beim Wechsel zwischen frei
    /// und eng — nie je Bericht.
    pub(crate) fn probe(&mut self, laufzeit: Duration, jetzt: Instant) -> Option<Meldung> {
        while self
            .proben
            .front()
            .is_some_and(|&(t, _)| jetzt.saturating_duration_since(t) > GRUNDWERT_FENSTER)
        {
            self.proben.pop_front();
        }
        self.proben.push_back((jetzt, laufzeit));
        let stau = laufzeit.saturating_sub(self.grundwert().unwrap_or(laufzeit));
        let alt = self.abschnitt.map_or(Duration::ZERO, |a| a.stau_max);
        self.abschnitt = Some(Abschnitt { letzte: laufzeit, stau_max: alt.max(stau) });

        if self.eng {
            if stau < FREI_STAU {
                self.eng = false;
                return Some(Meldung::Frei { laufzeit, stau });
            }
            return None;
        }
        if stau < ENG_STAU {
            self.ueber_seit = None;
            return None;
        }
        let seit = *self.ueber_seit.get_or_insert(jetzt);
        if jetzt.saturating_duration_since(seit) >= ENG_DAUER {
            self.eng = true;
            self.ueber_seit = None;
            return Some(Meldung::Eng { laufzeit, stau });
        }
        None
    }

    /// Kleinste Laufzeit im Fenster.
    pub(crate) fn grundwert(&self) -> Option<Duration> {
        self.proben.iter().map(|&(_, l)| l).min()
    }

    /// Der Teil für die Zeile „Strecke zum Server"; danach beginnt der
    /// Abschnitt neu. `None`, wenn seit der letzten Zeile keine Laufzeit kam.
    pub(crate) fn abschnitt_text(&mut self) -> Option<String> {
        let a = self.abschnitt.take()?;
        let grund = self.grundwert().unwrap_or(a.letzte);
        Some(format!(
            "Laufzeit {} ms (Grundwert {} ms, Stau bis +{} ms)",
            ms(a.letzte),
            ms(grund),
            ms(a.stau_max)
        ))
    }
}

#[cfg(test)]
#[path = "stau_tests.rs"]
mod tests;
