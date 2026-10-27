//! Kleiner VBV-Puffer am offenen Encoder, **nur solange eine Fernsteuerung
//! läuft** — die eine Ausnahme vom „`rc_buffer_size` bleibt ungesetzt"
//! (Absatz in `streaming/linux-hq-sidecar/src/encode/opts.rs`, NVENC-Zweig).
//!
//! **Gemessen** (2026-10-21, Sender: Windows-Rechner mit RTX 2080,
//! `hevc_nvenc`, 2500 kbit/s, 1080p60, zwei Bildschirme in Fernsteuerung):
//! ohne `rc_buffer_size` schreibt FFmpeg selbst `2 × Bitrate`
//! (n8.1 `nvenc.c:1182-1186`), also zwei Sekunden Puffer. Ein Vollbild war
//! damit rund 30-mal so groß wie ein P-Bild und hielt die 2,5-Mbit-Leitung
//! gut eine Drittelsekunde besetzt; zweimal löste genau das die nächste
//! Bildlücke aus.
//!
//! **Gefolgert, nicht gemessen:** mit N Bildern Puffer belegt ein einzelnes
//! Bild höchstens rund N Bildabstände Leitungszeit (bei 60 fps und N = 2
//! also ~33 ms statt ~330 ms). Der Preis ist derselbe, den die Abwägung vom
//! 2026-08-03 nennt: die Rate wird über den Quantisierer gehalten, ein
//! Vollbild und jede große Bildänderung kommen gröber und schärfen in den
//! Folgebildern nach. Bei der Fernsteuerung zählt die Reaktion vor der
//! Schärfe; beim bloßen Zusehen gilt die Abwägung weiter, deshalb nur
//! während der Sitzung. Ob die Lücken damit verschwinden, steht aus — dafür
//! war `PULSE_HQ_FERN_VBV_BILDER=0` der A/B-Schalter (seit 2026-10-27 ist aus
//! die Vorgabe, s. den nächsten Absatz).
//!
//! **Seit dem 2026-10-27 standardmäßig AUS** (Versuch nach RustDesk-Vorbild,
//! zusammen mit der Vollbild-Pause in `keyframe::Selbsttakt`): RustDesk setzt
//! kein `rc_buffer_size` (`rustdesk-org/hwcodec`, `cpp/common/util.cpp`) und
//! fährt damit FFmpegs 2 × Bitrate, schickt aber auch keine regulären
//! Vollbilder. Der kleine Puffer war die Antwort auf genau diese regulären
//! Vollbilder; ohne sie bleiben nur die angeforderten (Einstieg, Verlust).
//! Über RTMPS (ohne Rückkanal) bleiben die regulären Vollbilder stehen und
//! kommen jetzt wieder in voller Größe — dort misst der Versuch genau die
//! Abwägung von oben: Pumpen gegen Lücken.
//! Sein Preis dagegen stand am 2026-10-27 im Bild: die Vollbilder kamen mit
//! 8-11 KB (2 Bilder bei 2,5 Mbit/s ≈ 10 KB) grob an, das Bild pumpte im
//! Minutentakt. **Ob das ohne den Puffer verschwindet und ob die Lücken
//! zurückkommen, ist ungemessen.** Wer den alten Stand vergleichen will:
//! `PULSE_HQ_FERN_VBV_BILDER=2`.
//!
//! **Warum 2 und nicht 4 Bilder — gemessen** (2026-10-22, RTX 4090, Treiber
//! 615.78, FFmpeg 8 mit genau diesen NVENC-Optionen, Bildschirminhalt 1440p60
//! als verlustfreie Vorlage, Schärfe = Luma-PSNR der letzten Sekunde):
//! zwischen 2 und 2,5 Bildern schaltet NVENCs Ratensteuerung hart um. Bei 3
//! bis 12 Bildern verhielt sich `hevc_nvenc` überall gleich und schöpfte bei
//! ruhigem Bild nur ein Drittel des Budgets aus (4 Mbit/s eingestellt, 1,2
//! gesendet, 46 dB) — das Bild blieb unscharf, obwohl die Leitung frei war.
//! Das Log des Senders aus dem Messfall oben zeigte dasselbe: rund 2,6
//! Pakete je Bild statt der ~7, die 4 Mbit/s bei 60 fps tragen. Bei 2 Bildern
//! schöpft `hevc_nvenc` das Budget aus (4,2 Mbit/s, 53 dB; langsames
//! Scrollen 55 statt 47 dB), das größte Einzelbild bleibt gleich klein
//! (17 statt 20 kB) — der Grund für den kleinen Puffer gilt also weiter.
//! Kein Füllmaterial: im Strom stehen keine Filler-NALs, die Bits sind
//! Bildinhalt. Preis: über 250 ms schwankt die Rate bis ~1,3× statt ~1,1×
//! des Budgets. **1 Bild ist falsch** — dort sprengt der Encoder das Budget
//! (schnelles Scrollen 8,2 statt 4 Mbit/s). `av1_nvenc` verhält sich bei 2
//! und 4 Bildern gleich, `h264_nvenc` wird bei ruhigem Bild schärfer
//! (51,5 statt 43,7 dB); schlechter wird nirgends etwas. **Ungemessen:**
//! ob ältere NVENC-Generationen (der Messfall oben ist eine 2080, Turing)
//! an derselben Stelle umschalten — die Schwelle ist undokumentiertes
//! Treiberverhalten.
//! Prüfstein im Sender-Log: Pakete je Bild in `[whip] Verteilung je Bild`.
//!
//! **Warum das zur Laufzeit geht** (FFmpeg n8.1, `libavcodec/nvenc.c`, am
//! Quelltext geprüft, nicht am Treiber gemessen):
//!
//! * `nvenc_send_frame` ruft vor JEDEM Bild `reconfig_encoder` (Z. 3143).
//! * Dort wird `avctx->rc_buffer_size` übernommen, sobald es > 0 ist und vom
//!   laufenden `vbvBufferSize` abweicht (Z. 2995-3002) — **nur** wenn die
//!   Ratensteuerung nicht `constqp` ist und `support_dyn_bitrate` gilt
//!   (Z. 2974; die Fähigkeit `NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE`, einmal
//!   beim Öffnen abgefragt, Z. 679). Wir fahren `rc=cbr` (`opts.rs`).
//! * Jede solche Änderung setzt `resetEncoder = 1` und `forceIDR = 1`
//!   (Z. 3005-3007): **ein IDR je Umschalten**, also zwei je Sitzung.
//!   Hingenommen. Das IDR beim Einschalten entsteht schon unter dem kleinen
//!   Puffer; das beim Ausschalten unter dem großen — das eine große Vollbild
//!   fällt damit in den Moment, in dem die Sitzung endet. Das `send=` dieses
//!   einen Bildes trägt den Neuaufbau mit (`tick_monitor`).
//! * Scheitert `nvEncReconfigureEncoder`, schreibt FFmpeg nur ein Log
//!   (Z. 3018-3020) und kodiert mit den alten Werten weiter; auch bei
//!   fehlender Fähigkeit geschieht still nichts. Von aussen ist die Übernahme
//!   deshalb nur am IDR zu sehen — [`FernVbv::paket`] prüft die nächsten
//!   Pakete darauf und sagt es im Log.
//! * Rückweg: FFmpeg schreibt seinen Vorgabewert beim Öffnen in
//!   `avctx->rc_buffer_size` zurück (Z. 1185). Genau den merkt sich
//!   [`FernVbv::neu`] und setzt ihn beim Ende wieder ein; er ist > 0, die
//!   Bedingung aus Z. 2995 greift also auch in diese Richtung.
//!
//! **Wo es bewusst nichts tut:**
//!
//! * AMF — VBV gemessen wirkungslos (`encode/mod.rs`), und `amfenc_*.c` liest
//!   `rc_buffer_size` ohnehin nur beim Öffnen.
//! * `h264_d3d12va` — gemessen byte-gleich (`encode/mod.rs`), und
//!   `d3d12va_encode.c` kennt keinen Laufzeitweg; dieser Encoder läuft auch
//!   nicht über `FfmpegHwEncoder`.
//! * QSV (Intel, CPU-Weg) — FFmpeg könnte es (`qsvenc.c`, `update_bitrate`
//!   → `MFXVideoENCODE_Reset`), leert dafür aber den Encoder und bricht bei
//!   einem Fehlschlag das Einschieben ab, also den Strom. Ungemessen, kein
//!   Fern-Zweig im CPU-Weg — nicht gebaut.
//!
//! **Bewusst ohne Abhängigkeiten** (nur `std`): die Rechnung und die
//! Zustandsführung sind plattformfrei, und `cargo test` dieses Crates läuft nur
//! auf Windows. So lässt sich die Datei unter Linux allein prüfen
//! (`rustc --edition 2024 --test src/encode/fern_vbv.rs`). Den Zugriff auf
//! den `AVCodecContext` macht der Encoder (`encoder_hw.rs`).

/// Name des Schalters: nicht gesetzt oder `0` = aus (Vorgabe seit
/// 2026-10-27), 1-60 = Bilder. Wer ihn einschaltet, nimmt 2 — nicht 1, nicht
/// 3+, warum, steht oben unter „Warum 2 und nicht 4 Bilder".
pub const UMGEBUNG: &str = "PULSE_HQ_FERN_VBV_BILDER";
/// Obergrenze. Bei 60 fps eine Sekunde — darüber nähert sich der Wert dem
/// Regelpuffer von zwei Sekunden, und die Ausnahme verlöre ihren Zweck.
pub const HOECHSTENS_BILDER: u32 = 60;
/// So viele Pakete nach dem Umschalten wird auf das IDR gewartet. `delay=0`
/// gibt das Paket im selben Aufruf heraus (`latency.rs`); drei lassen Luft für
/// einen Encoder mit einem Bild Vorlauf.
const PRUEF_PAKETE: u8 = 3;

/// Wert der Umgebung → Anzahl Bilder; `Ok(None)` heißt abgeschaltet.
///
/// Nicht gesetzt, leer oder `0` = aus. Ein ungültiger Wert ist ein `Err` —
/// der Aufrufer meldet ihn und bleibt bei aus, damit ein Tippfehler im
/// A/B-Vergleich auffällt statt still eine andere Messung zu fahren.
pub fn bilder_aus(wert: Option<&str>) -> Result<Option<u32>, String> {
    let w = wert.map(str::trim).unwrap_or_default();
    if w.is_empty() {
        return Ok(None);
    }
    match w.parse::<u32>() {
        Ok(0) => Ok(None),
        Ok(n) if n <= HOECHSTENS_BILDER => Ok(Some(n)),
        _ => Err(format!(
            "{UMGEBUNG}={w} ungültig (0 = aus, 1-{HOECHSTENS_BILDER} = Bilder) — bleibt aus"
        )),
    }
}

/// N Bilder Puffer in **Bit** (`AVCodecContext::rc_buffer_size` zählt Bit):
/// `N × Bitrate / fps`, gerundet, mindestens 1, höchstens `i32::MAX`.
pub fn puffer_bits(bit_rate: i64, fps: u32, bilder: u32) -> i32 {
    let fps = i64::from(fps.max(1));
    let bits = bit_rate.max(0).saturating_mul(i64::from(bilder)).saturating_add(fps / 2) / fps;
    bits.clamp(1, i64::from(i32::MAX)) as i32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Plan {
    bilder: u32,
    fern_bits: i32,
    regel_bits: i32,
}

/// Zustand je Encoder: welcher Puffer gerade gilt und ob ein Umschalten noch
/// auf seine Bestätigung (das IDR) wartet.
#[derive(Debug)]
pub struct FernVbv {
    /// `None` = für diesen Encoder aus; der Grund steht im Log beim Öffnen.
    plan: Option<Plan>,
    aktiv: bool,
    pruefen: u8,
}

impl FernVbv {
    /// Direkt nach dem Öffnen des Encoders. `regel_bits` ist das
    /// `rc_buffer_size`, das FFmpeg beim Öffnen hinterlassen hat; `umgebung`
    /// der Wert von [`UMGEBUNG`]. Meldet das Ergebnis in einer Logzeile.
    pub fn neu(
        codec_name: &str,
        bit_rate: i64,
        fps: u32,
        regel_bits: i32,
        umgebung: Option<&str>,
    ) -> Self {
        let (plan, zeile) = planen(codec_name, bit_rate, fps, regel_bits, umgebung);
        eprintln!("[fern-vbv] {zeile}");
        Self { plan, aktiv: false, pruefen: 0 }
    }

    /// Fern-Zustand abgleichen, **vor** dem Einschieben jedes Bildes. Gibt das
    /// neue `rc_buffer_size` zurück, wenn umzuschalten ist, sonst `None`.
    pub fn abgleichen(&mut self, fern: bool) -> Option<i32> {
        let plan = self.plan?;
        if fern == self.aktiv {
            return None;
        }
        self.aktiv = fern;
        self.pruefen = PRUEF_PAKETE;
        let (alt, neu) = if fern {
            (plan.regel_bits, plan.fern_bits)
        } else {
            (plan.fern_bits, plan.regel_bits)
        };
        eprintln!(
            "[fern-vbv] {}: N={}, rc_buffer_size {alt} -> {neu} bit ({} B){}; NVENC baut dafür neu auf und erzwingt ein IDR",
            if fern { "an" } else { "aus" },
            plan.bilder,
            neu / 8,
            if fern { "" } else { " = wieder der Regelpuffer" },
        );
        Some(neu)
    }

    /// Je fertigem Video-Paket. Nach einem Umschalten wird auf das IDR
    /// gewartet, das FFmpeg dabei erzwingt — es ist das einzige Zeichen von
    /// aussen, dass der Encoder neu konfiguriert hat.
    pub fn paket(&mut self, vollbild: bool) {
        if self.pruefen == 0 {
            return;
        }
        if vollbild {
            self.pruefen = 0;
            eprintln!("[fern-vbv] IDR nach dem Umschalten gesehen — NVENC hat neu konfiguriert");
            return;
        }
        self.pruefen -= 1;
        if self.pruefen == 0 {
            eprintln!(
                "[fern-vbv] kein IDR in den ersten {PRUEF_PAKETE} Paketen nach dem Umschalten — \
                 NVENC hat den Puffer vermutlich NICHT übernommen (Fähigkeit \
                 SUPPORT_DYN_BITRATE_CHANGE fehlt oder nvEncReconfigureEncoder schlug fehl; \
                 FFmpeg-Log mit PULSE_HQ_FFMPEG_DEBUG=1)"
            );
        }
    }
}

/// Entscheidung samt Logzeile — getrennt von [`FernVbv::neu`], damit sie
/// ohne Encoder prüfbar ist.
fn planen(
    codec_name: &str,
    bit_rate: i64,
    fps: u32,
    regel_bits: i32,
    umgebung: Option<&str>,
) -> (Option<Plan>, String) {
    if codec_name.ends_with("_amf") {
        let grund = "AMF übernimmt VBV nicht (gemessen 2026-07-30, encode/mod.rs)";
        return (None, format!("aus: {codec_name} — {grund}"));
    }
    if !codec_name.ends_with("_nvenc") {
        return (None, format!("aus: {codec_name} — kein Laufzeitweg für den Puffer"));
    }
    let bilder = match bilder_aus(umgebung) {
        Ok(Some(n)) => n,
        Ok(None) => {
            return (None, format!("aus: {UMGEBUNG} nicht gesetzt oder 0 (Regelpuffer auch bei Fernsteuerung)"));
        }
        Err(warnung) => return (None, format!("aus: {warnung}")),
    };
    if regel_bits <= 0 {
        return (None, format!("aus: Encoder meldet keinen Regelpuffer (rc_buffer_size={regel_bits})"));
    }
    let fern_bits = puffer_bits(bit_rate, fps, bilder);
    if fern_bits >= regel_bits {
        return (
            None,
            format!("aus: {bilder} Bilder = {fern_bits} bit wären nicht kleiner als der Regelpuffer ({regel_bits} bit)"),
        );
    }
    let zeile = format!(
        "bereit: {codec_name}, bei Fernsteuerung N={bilder} Bilder = {fern_bits} bit ({} B), sonst {regel_bits} bit ({} B)",
        fern_bits / 8,
        regel_bits / 8,
    );
    (Some(Plan { bilder, fern_bits, regel_bits }), zeile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn umgebung_auslegen() {
        assert_eq!(bilder_aus(None), Ok(None), "nicht gesetzt = aus (seit 2026-10-27)");
        assert_eq!(bilder_aus(Some("0")), Ok(None));
        assert_eq!(bilder_aus(Some("")), Ok(None));
        assert_eq!(bilder_aus(Some(" 8 ")), Ok(Some(8)));
        assert_eq!(bilder_aus(Some("1")), Ok(Some(1)));
        assert_eq!(bilder_aus(Some("60")), Ok(Some(60)));
        assert!(bilder_aus(Some("61")).is_err());
        assert!(bilder_aus(Some("-1")).is_err());
        assert!(bilder_aus(Some("vier")).is_err());
    }

    /// Der Messfall mit der Vorgabe bis 0.1.134: 2500 kbit/s, 60 fps,
    /// 4 Bilder = 166 667 bit ≈ 20,8 kB.
    #[test]
    fn puffer_des_messfalls() {
        assert_eq!(puffer_bits(2_500_000, 60, 4), 166_667);
        assert_eq!(puffer_bits(2_500_000, 60, 4) / 8, 20_833);
        // Ein Bild = Bitrate/fps, NVIDIAs Low-Latency-Empfehlung.
        assert_eq!(puffer_bits(6_000_000, 60, 1), 100_000);
    }

    #[test]
    fn puffer_grenzen() {
        assert_eq!(puffer_bits(0, 60, 4), 1);
        assert_eq!(puffer_bits(2_500_000, 0, 4), 10_000_000, "fps 0 zählt als 1");
        assert_eq!(puffer_bits(i64::MAX / 100, 1, 60), i32::MAX);
    }

    #[test]
    fn nur_nvenc() {
        let regel = 5_000_000;
        assert!(planen("hevc_nvenc", 2_500_000, 60, regel, Some("2")).0.is_some());
        assert!(planen("av1_nvenc", 2_500_000, 60, regel, Some("2")).0.is_some());
        assert!(planen("av1_amf", 2_500_000, 60, regel, Some("2")).0.is_none());
        assert!(planen("h264_qsv", 2_500_000, 60, regel, Some("2")).0.is_none());
    }

    #[test]
    fn abschaltbar_und_unsinnig() {
        assert!(planen("hevc_nvenc", 2_500_000, 60, 5_000_000, Some("0")).0.is_none());
        assert!(planen("hevc_nvenc", 2_500_000, 60, 0, Some("2")).0.is_none());
        // 60 Bilder bei 30 fps = 2 s = so groß wie der Regelpuffer.
        assert!(planen("hevc_nvenc", 2_500_000, 30, 5_000_000, Some("60")).0.is_none());
        // Ungültig und nicht gesetzt: aus, wie die Vorgabe.
        assert!(planen("hevc_nvenc", 2_500_000, 60, 5_000_000, Some("x")).0.is_none());
        assert!(planen("hevc_nvenc", 2_500_000, 60, 5_000_000, None).0.is_none());
    }

    /// Hin und zurück, und nur beim Umspringen — nicht bei jedem Bild.
    #[test]
    fn umschalten_hin_und_zurueck() {
        let mut v = FernVbv::neu("hevc_nvenc", 2_500_000, 60, 5_000_000, Some("2"));
        assert_eq!(v.abgleichen(false), None);
        assert_eq!(v.abgleichen(true), Some(83_333));
        assert_eq!(v.abgleichen(true), None);
        assert_eq!(v.abgleichen(false), Some(5_000_000));
        assert_eq!(v.abgleichen(false), None);
    }

    #[test]
    fn aus_heisst_nie_umschalten() {
        let mut v = FernVbv::neu("av1_amf", 2_500_000, 60, 5_000_000, Some("2"));
        assert_eq!(v.abgleichen(true), None);
        assert_eq!(v.abgleichen(false), None);
    }

    #[test]
    fn idr_pruefung() {
        let mut v = FernVbv::neu("hevc_nvenc", 2_500_000, 60, 5_000_000, Some("2"));
        v.paket(true); // ohne Umschalten: nichts zu prüfen
        assert_eq!(v.pruefen, 0);
        v.abgleichen(true);
        assert_eq!(v.pruefen, PRUEF_PAKETE);
        v.paket(false);
        v.paket(true);
        assert_eq!(v.pruefen, 0, "IDR gesehen, Prüfung beendet");
        v.abgleichen(false);
        for _ in 0..PRUEF_PAKETE {
            v.paket(false);
        }
        assert_eq!(v.pruefen, 0, "nach drei Paketen ohne IDR aufgegeben");
    }
}
