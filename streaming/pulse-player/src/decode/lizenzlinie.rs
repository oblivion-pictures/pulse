//! HEVC nur in Hardware — auch dann, wenn FFmpeg still ausweicht.
//!
//! **Die Luecke, die das schliesst.** Fuer HEVC bietet die Kandidatenliste
//! bewusst keinen Software-Decoder an (Lizenzlinie, s. `Codec::H265` in
//! `whep.rs`). Der Kandidat „nativer `hevc` mit hwaccel-Geraet" IST aber der
//! Software-Decoder, nur mit angehaengtem Geraet: kann die Hardware das Profil
//! des Stroms nicht, faellt FFmpeg beim ersten Bild still auf das
//! Softwareformat zurueck (`avcodec_default_get_format` waehlt dann „the first
//! software format", `libavcodec/decode.c`). Geoeffnet hat der Decoder da
//! laengst, die Liste geht also nie zum naechsten Kandidaten weiter.
//!
//! **Wo das zuschlaegt (aus der FFmpeg-Quelle n8.1.1 gelesen, nicht
//! gemessen):** `libavcodec/hevc/hevcdec.c` bietet fuer `YUV444P` nur VAAPI,
//! VDPAU, CUDA, VideoToolbox und Vulkan an — **kein D3D11VA**. Unter Windows
//! steht der native Decoder mit D3D11VA vorn (`ZUERST_NATIV_HW`), ein
//! 4:4:4-Strom liefe dort also durch den Software-Decoder. Dasselbe gilt fuer
//! VAAPI-Treiber ohne `VAProfileHEVCMain444`, und grundsaetzlich auch bei
//! 4:2:0 auf Hardware ohne HEVC.
//!
//! **Erkannt wird es am Bild, nicht am Profil**: ein Decoder mit Geraet, der
//! ein Bild im Hauptspeicher herausgibt, hat nicht in Hardware dekodiert. Bei
//! `*_cuvid` ohne Geraet ist das anders (dort legt NVDEC das Bild selbst im
//! Hauptspeicher ab) — deshalb zaehlt nur ein Kandidat MIT Geraet.

use anyhow::{bail, Result};

use super::VideoDecoder;
use crate::whep::Codec;

/// Hat ein HEVC-Decoder mit Geraet dieses Bild in Software dekodiert?
///
/// `mit_geraet` heisst: der Kandidat traegt ein hwaccel-Geraet
/// (`Kandidat::hw`). `auf_gpu`: das Bild liegt im Grafikspeicher
/// (`AUF_GPU_FORMATE`).
pub(super) fn hevc_in_software(codec: Codec, mit_geraet: bool, auf_gpu: bool) -> bool {
    codec == Codec::H265 && mit_geraet && !auf_gpu
}

impl VideoDecoder {
    /// Auf den naechsten HARDWARE-Kandidaten der Liste weiterschalten, weil
    /// der laufende HEVC in Software dekodiert haette.
    ///
    /// **Weiter, nicht von vorn**: von vorn kaeme derselbe Kandidat wieder.
    /// Unter Windows ist der naechste `hevc_cuvid` (NVDEC kann 4:4:4); gibt es
    /// keinen tragenden mehr, endet die Sitzung mit einer Meldung — eine
    /// Software-Dekodierung gibt es fuer HEVC nicht.
    ///
    /// Zaehlt nicht gegen `neuaufbau::MAX_REBUILDS`: kaputt ist nichts, der
    /// Kandidat kann das Profil nur nicht. Begrenzt ist es trotzdem — jeder
    /// Schritt geht in der Liste weiter, und die ist endlich.
    pub(super) fn hevc_weiterschalten(&mut self) -> Result<()> {
        eprintln!(
            "pulse-player: Decoder {} ({}) wuerde HEVC in Software dekodieren — die \
             Hardware kann dieses Profil nicht; naechster Hardware-Kandidat",
            self.name,
            self.kandidat.beschreibung()
        );
        let naechster =
            Self::ab_kandidat(self.codec, Some(true), self.geraet.clone(), self.kandidat_nr + 1);
        match naechster {
            Ok(fresh) if fresh.hardware => {
                self.decoder_uebernehmen(fresh);
                Ok(())
            }
            _ => bail!(
                "HEVC: kein Hardware-Decoder kann dieses Profil (etwa 4:4:4) — \
                 Software-Dekodierung ist fuer HEVC ausgeschlossen"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nur_hevc_mit_geraet_im_hauptspeicher_faellt_auf() {
        // Der Fall: nativer `hevc` mit D3D11VA/VAAPI, Bild kommt als YUV444P.
        assert!(hevc_in_software(Codec::H265, true, false));
        // Hardware hat geliefert (VAAPI-/CUDA-/D3D11-Bild).
        assert!(!hevc_in_software(Codec::H265, true, true));
        // `hevc_cuvid` ohne Geraet legt sein Bild selbst im Hauptspeicher ab.
        assert!(!hevc_in_software(Codec::H265, false, false));
        // H.264 und AV1 duerfen in Software dekodieren.
        assert!(!hevc_in_software(Codec::H264, true, false));
        assert!(!hevc_in_software(Codec::Av1, true, false));
    }

    /// Das Weiterschalten geht in der Liste VORWAERTS, bleibt auf Hardware und
    /// endet, wenn keine mehr da ist, mit einem Fehler — nie in Software.
    /// Ohne HEVC-faehige Hardware (Bauserver) uebersprungen.
    #[test]
    fn weiterschalten_geht_vorwaerts_und_endet_ohne_software() {
        let Ok(mut d) = VideoDecoder::new(Codec::H265, Some(true), None) else {
            eprintln!("kein HEVC-Hardware-Decoder — Weiterschalten nicht geprueft");
            return;
        };
        for _ in 0..16 {
            let vorher = d.kandidat_nr;
            match d.hevc_weiterschalten() {
                Ok(()) => {
                    assert!(d.kandidat_nr > vorher, "zurueck statt weiter: {}", d.name);
                    assert!(d.hardware, "{} ist keine Hardware", d.name);
                    assert!(d.awaiting_keyframe, "der neue Decoder braucht ein Vollbild");
                }
                Err(e) => {
                    assert!(format!("{e}").contains("ausgeschlossen"), "{e}");
                    return;
                }
            }
        }
        panic!("Weiterschalten endet nicht");
    }

    /// **Ende-zu-Ende:** ein Strom, den der Hardware-Kandidat nicht kann,
    /// durch den echten `decode`. Die Schranke muss feuern, bevor ein
    /// Software-Bild hinausgeht. Laeuft nur mit `PULSE_PLAYER_HEVC_SCHRANKE`
    /// (roher `.hevc`-Strom). Auf einer RTX 5080 mit nvidia-vaapi-driver
    /// (kein `VAProfileHEVCMain422`) nachgestellt mit
    /// `PULSE_PLAYER_DECODER=hevc+hw,hevc_cuvid` und einem 4:2:2-Strom aus
    /// `hevc_nvenc` (`-vf format=yuv422p`).
    #[test]
    fn strom_ohne_hardwareprofil_schaltet_weiter() {
        use ffmpeg_next as ffmpeg;
        let Ok(strom) = std::env::var("PULSE_PLAYER_HEVC_SCHRANKE") else {
            eprintln!("uebersprungen: PULSE_PLAYER_HEVC_SCHRANKE nicht gesetzt");
            return;
        };
        let mut d = VideoDecoder::new(Codec::H265, Some(true), None).expect("HEVC-Decoder");
        let erster = d.name.clone();
        let mut input = ffmpeg::format::input(&strom).expect("Strom lesbar");
        for (_, paket) in input.packets() {
            let Some(daten) = paket.data() else { continue };
            let vorher = d.name.clone();
            match d.decode(daten) {
                Ok(bilder) => assert!(
                    bilder.is_empty() || d.name != erster,
                    "{vorher} hat {} Bild(er) in Software herausgegeben",
                    bilder.len()
                ),
                Err(e) => {
                    eprintln!("Sitzungsende: {e:#}");
                    break;
                }
            }
        }
        eprintln!("Decoder am Anfang {erster}, am Ende {}", d.name);
        assert_ne!(d.name, erster, "die Schranke hat nicht weitergeschaltet");
    }
}
