//! Lage der Grafikkarte für die Logzeilen von [`super::prioritaet`]: ob die
//! hardwarebeschleunigte GPU-Planung (HAGS) an ist und wie viel Grafikspeicher
//! dieser Prozess gegen sein Budget belegt — beides Kandidaten für die Ursache
//! eines Hängers im Encoder-Submit, gegen die Vorrang allein wenig hilft.
//!
//! Herausgezogen, damit `prioritaet.rs` unter der Größen-Grenze bleibt
//! (`PLAN.md` §12.1).

use windows::Wdk::Graphics::Direct3D::{
    D3DKMT_CLOSEADAPTER, D3DKMT_OPENADAPTERFROMLUID, D3DKMT_QUERYADAPTERINFO, D3DKMT_WDDM_2_7_CAPS,
    D3DKMTCloseAdapter, D3DKMTOpenAdapterFromLuid, D3DKMTQueryAdapterInfo, KMTQAITYPE_WDDM_2_7_CAPS,
};
use windows::Win32::Foundation::LUID;
use windows::Win32::Graphics::Dxgi::{
    DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter, IDXGIAdapter3,
};
use windows::core::Interface;

/// HAGS (hardwarebeschleunigte GPU-Planung) an diesem Adapter — wie Sunshine
/// und OBS über `D3DKMTQueryAdapterInfo(KMTQAITYPE_WDDM_2_7_CAPS)`.
pub(super) fn hags(luid: LUID) -> Option<bool> {
    let mut offen = D3DKMT_OPENADAPTERFROMLUID { AdapterLuid: luid, hAdapter: 0 };
    // SAFETY: Strukturen leben über die Aufrufe; der Adapter wird geschlossen.
    if unsafe { D3DKMTOpenAdapterFromLuid(&mut offen) }.is_err() {
        return None;
    }
    let mut caps = D3DKMT_WDDM_2_7_CAPS::default();
    let mut frage = D3DKMT_QUERYADAPTERINFO {
        hAdapter: offen.hAdapter,
        Type: KMTQAITYPE_WDDM_2_7_CAPS,
        pPrivateDriverData: (&raw mut caps).cast(),
        PrivateDriverDataSize: size_of::<D3DKMT_WDDM_2_7_CAPS>() as u32,
    };
    let ok = unsafe { D3DKMTQueryAdapterInfo(&mut frage) }.is_ok();
    let _ = unsafe { D3DKMTCloseAdapter(&D3DKMT_CLOSEADAPTER { hAdapter: offen.hAdapter }) };
    ok.then(|| hags_an(unsafe { caps.Anonymous.Value }))
}

/// Bit 1 von `D3DKMT_WDDM_2_7_CAPS` ist `HwSchEnabled` (Bit 0 `HwSchSupported`,
/// Bit 2 `HwSchEnabledByDefault`; `d3dkmthk.h`).
fn hags_an(caps: u32) -> bool {
    caps & 0b10 != 0
}

/// Belegung dieses Prozesses gegen das Budget, das Windows ihm im lokalen
/// Grafikspeicher zugesteht. Ein Budget weit unter der Kartengröße heißt: ein
/// anderes Programm hält den Speicher.
pub(super) fn grafikspeicher(adapter: &IDXGIAdapter) -> Option<String> {
    let a3: IDXGIAdapter3 = adapter.cast().ok()?;
    let gesamt = unsafe { adapter.GetDesc() }.ok()?.DedicatedVideoMemory >> 20;
    let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
    unsafe { a3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info) }.ok()?;
    Some(format!(
        "{} MiB belegt, Budget {} MiB, Karte {gesamt} MiB",
        info.CurrentUsage >> 20,
        info.Budget >> 20
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hags_bit() {
        assert!(!hags_an(0b001), "nur unterstützt");
        assert!(hags_an(0b010));
        assert!(hags_an(0b111));
        assert!(!hags_an(0b100), "nur Vorgabe");
    }
}
