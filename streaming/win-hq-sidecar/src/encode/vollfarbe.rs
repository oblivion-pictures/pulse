//! Volle Farbauflösung (4:4:4) — wann sie gilt und wie der Encoder sie bekommt.
//!
//! Eingebaut am 2026-10-27 zum Ausprobieren in der Fernsteuerung: farbige
//! Schrift und feine Linien verlieren in 4:2:0 die halbe Farbauflösung, und
//! genau die liest man auf einem fremden Bildschirm. Gemessen am selben Tag an
//! einer Textseite (2560x1440, RTX 5080, HEVC 4000 kbit/s): 39,4 dB RGB-PSNR
//! in 4:2:0, 47,0 dB in 4:4:4.
//!
//! **Der Weg ist der, den der 8-bit-Strom ohnehin nimmt.** Der Pool führt
//! BGRA, und NVENC wandelt selbst nach YUV (`bildencoder::pool_wahl`). FFmpegs
//! Schalter `rgb_mode=yuv444` (in n8.1 vorhanden, `libavcodec/nvenc.c`) lässt
//! diese Wandlung die volle Farbauflösung behalten und setzt das Profil selbst:
//! H.264 High 4:4:4 Predictive, HEVC Rext, AV1 `chromaFormatIDC=3`. Die
//! Farbsignalisierung bleibt dieselbe wie beim heutigen 8-bit-Strom (BT.601,
//! begrenzter Bereich — nvenc.c setzt sie für jeden RGB-Eingang); gemessen am
//! 2026-10-27 mit FFmpeg 9 unter Linux an `hevc_nvenc` und `h264_nvenc`.
//!
//! **Kein Abbruch, wenn es nicht geht** — anders als bei 10 bit
//! ([`super::zehnbit`]). Der Strom startet dann in 4:2:0, und die Log-Zeile
//! sagt warum. Begründung: der Wunsch kommt aus dem Profil eines
//! Standplatz-Geräts, vor dem niemand sitzt; ein Weckruf, der an einer
//! Qualitätsfrage scheitert, ist dort die schlimmere Antwort. Und anders als
//! „8 statt 10 bit" bleibt die Abweichung nicht unsichtbar: der Player kennt
//! das Pixelformat jedes Bildes.
//!
//! **Was es heute nicht gibt:** AMD (AMF kennt keinen 4:4:4-Eingang), den
//! CPU- und den D3D12-Weg, und 4:4:4 zusammen mit 10 bit oder HDR (der Pool
//! führt dann P010, also schon 4:2:0, bevor der Encoder ihn sieht). AV1 in
//! 4:4:4 kann nach der NVIDIA-Tabelle keine GeForce encodieren — der Versuch
//! scheitert beim Öffnen, und `encoder_hw` öffnet dann ohne.

use ffmpeg_next::ffi::AVPixelFormat;
use ffmpeg_next::Dictionary;

use super::bildencoder::PoolWahl;

/// Gilt 4:4:4 für diesen Strom? `wunsch` = `chroma: "444"` im Start-Request.
///
/// Einmal je Start aus `pipeline_hw::run`, mit dem Pool, den der Encoder
/// wirklich bekommt. Sagt bei einer Absage in EINER Zeile, woran es lag.
pub(crate) fn entscheiden(wunsch: bool, vendor: &str, pool: &PoolWahl) -> bool {
    if !wunsch {
        return false;
    }
    match absage(vendor, pool) {
        None => true,
        Some(grund) => {
            eprintln!("[vollfarbe] 4:4:4 verlangt, {grund} -> 4:2:0");
            false
        }
    }
}

/// Dieselbe Prüfung ohne Log-Zeile — für den Direktweg, der vor dem ersten
/// Bild aushandelt und dieselbe Antwort braucht (`direct::aushandle`); die
/// Zeile schreibt danach `pipeline_hw` einmal.
pub(crate) fn absage(vendor: &str, pool: &PoolWahl) -> Option<&'static str> {
    if vendor != "nvidia" {
        Some("nur mit NVENC (NVIDIA)")
    } else if pool.format != AVPixelFormat::AV_PIX_FMT_BGRA {
        Some("nur in 8 bit ohne HDR (der Pool fuehrt schon 4:2:0)")
    } else {
        None
    }
}

/// Den Encoder auf 4:4:4 stellen. Nur für `*_nvenc` mit BGRA-Eingang
/// aufzurufen (s. [`entscheiden`]).
pub fn einschalten(opts: &mut Dictionary) {
    opts.set("rgb_mode", "yuv444");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(format: AVPixelFormat) -> PoolWahl {
        PoolWahl { format, geteilt: false, ten_bit: format == AVPixelFormat::AV_PIX_FMT_P010LE }
    }

    #[test]
    fn nur_nvidia_mit_bgra_pool() {
        let bgra = pool(AVPixelFormat::AV_PIX_FMT_BGRA);
        assert!(entscheiden(true, "nvidia", &bgra));
        assert!(!entscheiden(false, "nvidia", &bgra));
        assert!(!entscheiden(true, "amd", &bgra));
        assert!(!entscheiden(true, "intel", &bgra));
        assert!(!entscheiden(true, "nvidia", &pool(AVPixelFormat::AV_PIX_FMT_P010LE)));
    }
}
