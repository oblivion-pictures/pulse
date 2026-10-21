//! Vorrang beim Streamen: Prozess-, Faden- und GPU-Priorität.
//!
//! **Anlass** (Messung 2026-10-21, Sender: Windows-Rechner einer Medienfirma
//! mit RTX 2080, `hevc_nvenc`, zwei Bildschirme in Fernsteuerung): `[diag]
//! slow tick` mit `send=` 90-133 ms, auf BEIDEN Bildschirmen in derselben
//! Millisekunde. `send` ist `avcodec_send_frame`, die Übergabe an die GPU.
//! Bis dahin setzte der Sidecar keinerlei Priorität. **Vermutung, nicht
//! belegt:** die GPU wird mit Vordergrund-Programmen geteilt (wahrscheinlich
//! Schnittsoftware), und der Encoder-Submit wartet hinter deren Arbeit. Dass
//! zwei getrennte Sidecar-Prozesse gleichzeitig hängen, spricht für eine
//! Ursache ausserhalb der Ströme (GPU-Planung oder Speicherdruck). Ob dieses
//! Modul die Hänger beseitigt, steht aus — `PULSE_HQ_PRIORITAET=0` schaltet
//! es für den A/B-Vergleich ab.
//!
//! **Was gesetzt wird, und woher.** Vorbild ist Sunshine
//! (`src/platform/windows/misc.cpp`, `display_base.cpp`, `display_vram.cpp`,
//! `src/video.cpp`, Stand master 2026-10-21), gegengelesen an OBS
//! (`libobs-d3d11/d3d11-subsystem.cpp`, `set_priority`):
//!
//! 1. **Prozess `ABOVE_NORMAL_PRIORITY_CLASS`.** Sunshine nimmt
//!    `HIGH_PRIORITY_CLASS`. Hier eine Stufe darunter, weil der Sidecar neben
//!    genau den Programmen läuft, die der Fernsteuernde bedient — die müssen
//!    flüssig bleiben —, und weil der gemessene Hänger an der GPU sitzt, nicht
//!    an der CPU. Sunshine läuft dagegen meist als Dienst auf einem Rechner,
//!    an dem niemand sonst arbeitet.
//! 2. **Taktfaden `THREAD_PRIORITY_ABOVE_NORMAL`** — wie Sunshines
//!    Encode-Faden (`thread_priority_e::high`).
//! 3. **GPU-Planungsklasse HIGH** (`D3DKMTSetProcessSchedulingPriorityClass`,
//!    gilt für alle GPU-Kontexte des Prozesses, also auch die NVENC-eigenen).
//!    Sunshine und OBS nehmen REALTIME und fallen bei eingeschaltetem HAGS auf
//!    HIGH zurück (Sunshine nur auf NVIDIA). Sunshines Begründung im Wortlaut:
//!    *„NVIDIA driver has unfixed bug(s) where 'realtime' can cause
//!    unrecoverable encoding freeze or outright driver crash. This issue
//!    happens more frequently with HAGS, in DX12 games or when VRAM is filled
//!    close to max capacity."* Der Messrechner ist NVIDIA mit Schnittsoftware,
//!    die den Grafikspeicher füllt — genau dieses Bild. Deshalb hier immer
//!    HIGH, nie REALTIME (das verlangt ausserdem Adminrechte).
//! 4. **`IDXGIDevice::SetGPUThreadPriority(7)`** auf dem D3D11-Gerät der
//!    Aufnahme, das im Zero-Copy-Weg zugleich das des Skalierers und des
//!    Encoders ist ([`geraet`]). 7 ist der Höchstwert; Sunshine setzt ihn auf
//!    Aufnahme- und Encoder-Gerät und warnt beim Fehlschlag „run application
//!    as administrator". Ob er ohne Erhebung greift, ist hier ungemessen —
//!    deshalb steht das HRESULT in der Logzeile.
//! 5. **Recht `SeIncreaseBasePriorityPrivilege` einschalten**, falls es im
//!    Token steht (Sunshine tut das vor 3 und 4). Ohne Erhebung steht es nicht
//!    drin; dann ist es ein Leerlauf, und die Logzeile sagt das — genau die
//!    Angabe, die man braucht, um einen Fehlschlag bei 3/4 einzuordnen.
//!
//! **Nicht übernommen:**
//!
//! * **MMCSS** (`AvSetMmThreadCharacteristicsW`). Sunshine verwendet es für
//!   keinen eigenen Faden, nur `DwmEnableMMCSS` für den Fenstermanager.
//!   MMCSS hebt die CPU-Planung; gemessen hängt die Übergabe an die GPU, und
//!   ein Faden, der im Treiber wartet, wartet mit MMCSS genauso.
//! * **`DwmEnableMMCSS`** — wirkt auf den Fenstermanager des ganzen Systems,
//!   nicht auf diesen Prozess; ungemessen.
//! * **REALTIME** und **`HIGH_PRIORITY_CLASS`** — s. 1 und 3.
//!
//! **Zuordnung: nur während des Streamens.** [`streamen`] hebt beim Start
//! des Pipeline-Fadens an, der Wächter setzt Prozess- und GPU-Klasse beim Ende
//! auf den vorigen Stand zurück — wie Sunshines `streaming_will_stop`. Im
//! Server-Weg endet der Prozess ohnehin nach `stop`; im Direktmodus lebt er im
//! Wartezustand weiter und soll dort nicht bevorzugt laufen.
//!
//! **Fail-soft:** jeder Schritt meldet Ergebnis und Fehlercode; keiner kann
//! den Start verhindern.
//!
//! **Abgedeckte Wege:** D3D11-Zero-Copy (`pipeline_hw/capture_start.rs`) und
//! D3D12-Weg (Aufnahme-Gerät in `capture/wgc_d3d12.rs`; das D3D12-Gerät des
//! Encoders erreicht nur die Planungsklasse aus 3). Der CPU-Weg (Intel, Notaus
//! `PULSE_HQ_DISABLE_ZERO_COPY`) bekommt 1 und 2, aber keine GPU-Stufe — OBS
//! lässt die GPU-Priorität auf Intel ebenfalls aus.

use std::sync::Mutex;

use windows::Wdk::Graphics::Direct3D::{
    D3DKMT_CLOSEADAPTER, D3DKMT_OPENADAPTERFROMLUID, D3DKMT_QUERYADAPTERINFO,
    D3DKMT_SCHEDULINGPRIORITYCLASS, D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH, D3DKMT_WDDM_2_7_CAPS,
    D3DKMTCloseAdapter, D3DKMTGetProcessSchedulingPriorityClass, D3DKMTOpenAdapterFromLuid,
    D3DKMTQueryAdapterInfo, D3DKMTSetProcessSchedulingPriorityClass, KMTQAITYPE_WDDM_2_7_CAPS,
};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, LUID, NTSTATUS,
};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::Dxgi::{
    DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter, IDXGIAdapter3,
    IDXGIDevice,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW, SE_INC_BASE_PRIORITY_NAME,
    SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    ABOVE_NORMAL_PRIORITY_CLASS, GetCurrentProcess, GetCurrentThread, GetPriorityClass,
    OpenProcessToken, PROCESS_CREATION_FLAGS, SetPriorityClass, SetThreadPriority,
    THREAD_PRIORITY_ABOVE_NORMAL,
};
use windows::core::{Interface, PCWSTR};

/// `0` schaltet das ganze Modul ab (A/B-Vergleich), Vorgabe an.
pub const UMGEBUNG: &str = "PULSE_HQ_PRIORITAET";
/// Höchstwert von `SetGPUThreadPriority` (Bereich -7..=7), wie Sunshine.
const GPU_FADEN: i32 = 7;

/// GPU-Klasse vor dem Anheben — gesetzt, sobald [`geraet`] sie gehoben hat.
/// Ein Wert je Prozess, weil die Klasse am Prozess hängt; der Wächter aus
/// [`streamen`] nimmt ihn beim Ende heraus und setzt zurück.
static GPU_VORHER: Mutex<Option<D3DKMT_SCHEDULINGPRIORITYCLASS>> = Mutex::new(None);

fn an() -> bool {
    crate::env::flag_default_on(UMGEBUNG)
}

/// Wächter aus [`streamen`]: setzt beim Fallenlassen zurück.
#[must_use = "beim Fallenlassen wird die Priorität zurückgesetzt"]
pub struct Vorrang {
    cpu_vorher: Option<u32>,
}

/// Prozess und aufrufenden Faden anheben. Auf dem Pipeline-Faden rufen — er
/// ist zugleich der Taktfaden. `None`, wenn per [`UMGEBUNG`] abgeschaltet.
pub fn streamen() -> Option<Vorrang> {
    if !an() {
        eprintln!("[prioritaet] aus ({UMGEBUNG}=0): Prozess, Faden und GPU bleiben auf Normal");
        return None;
    }
    eprintln!("[prioritaet] Recht SeIncreaseBasePriority: {}", recht_einschalten());
    // SAFETY: Pseudo-Handles des eigenen Prozesses/Fadens, nie ungültig.
    let vorher = unsafe { GetPriorityClass(GetCurrentProcess()) };
    let cpu_vorher = match unsafe { SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS) } {
        Ok(()) => {
            eprintln!("[prioritaet] Prozess: ABOVE_NORMAL (vorher {}) ok", klasse(vorher));
            (vorher != 0).then_some(vorher)
        }
        Err(e) => {
            eprintln!("[prioritaet] Prozess: ABOVE_NORMAL fehlgeschlagen: {}", fehler(&e));
            None
        }
    };
    match unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL) } {
        Ok(()) => eprintln!("[prioritaet] Taktfaden: ABOVE_NORMAL ok"),
        Err(e) => eprintln!("[prioritaet] Taktfaden: ABOVE_NORMAL fehlgeschlagen: {}", fehler(&e)),
    }
    Some(Vorrang { cpu_vorher })
}

impl Drop for Vorrang {
    fn drop(&mut self) {
        if let Some(alt) = self.cpu_vorher {
            let r = unsafe { SetPriorityClass(GetCurrentProcess(), PROCESS_CREATION_FLAGS(alt)) };
            eprintln!("[prioritaet] zurück: Prozess {} {}", klasse(alt), ergebnis(r));
        }
        let gpu = GPU_VORHER.lock().ok().and_then(|mut g| g.take());
        if let Some(alt) = gpu {
            let st = unsafe { D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess(), alt) };
            eprintln!("[prioritaet] zurück: GPU-Klasse {} {}", gpu_klasse(alt), nt(st));
        }
    }
}

/// GPU-Stufe für ein D3D11-Gerät: Planungsklasse des Prozesses (einmal je
/// Strom), `SetGPUThreadPriority` am Gerät, dazu HAGS und Grafikspeicher in
/// die Logzeile — beides Kandidaten für die Ursache des Hängers.
pub fn geraet(device: &ID3D11Device, wofuer: &str) {
    if !an() {
        return;
    }
    gpu_klasse_heben();
    let dxgi: IDXGIDevice = match device.cast() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[prioritaet] Gerät {wofuer}: kein IDXGIDevice: {}", fehler(&e));
            return;
        }
    };
    let faden = unsafe { dxgi.SetGPUThreadPriority(GPU_FADEN) };
    let adapter = unsafe { dxgi.GetAdapter() }.ok();
    let desc = adapter.as_ref().and_then(|a| unsafe { a.GetDesc() }.ok());
    let hags = match desc.as_ref().and_then(|d| hags(d.AdapterLuid)) {
        Some(true) => "an",
        Some(false) => "aus",
        None => "unbekannt",
    };
    let speicher = adapter.as_ref().and_then(grafikspeicher).unwrap_or_else(|| "unbekannt".into());
    eprintln!(
        "[prioritaet] Gerät {wofuer}: SetGPUThreadPriority({GPU_FADEN}) {}; HAGS {hags}; Grafikspeicher {speicher}",
        ergebnis(faden),
    );
}

fn gpu_klasse_heben() {
    let Ok(mut vorher) = GPU_VORHER.lock() else { return };
    if vorher.is_some() {
        return; // in diesem Strom schon gehoben
    }
    let mut alt = D3DKMT_SCHEDULINGPRIORITYCLASS::default();
    // SAFETY: Pseudo-Handle des eigenen Prozesses; `alt` ist ein gültiges Ziel.
    let gelesen = unsafe { D3DKMTGetProcessSchedulingPriorityClass(GetCurrentProcess(), &mut alt) };
    let st = unsafe {
        D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess(), D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH)
    };
    let war = if gelesen.is_ok() { gpu_klasse(alt) } else { "unbekannt" };
    eprintln!("[prioritaet] GPU-Planungsklasse: HIGH (vorher {war}) {}", nt(st));
    if st.is_ok() && gelesen.is_ok() {
        *vorher = Some(alt);
    }
}

/// Schaltet das Recht ein, falls es im Token steht. Antwort für die Logzeile.
fn recht_einschalten() -> String {
    let mut token = HANDLE::default();
    // SAFETY: eigenes Prozess-Token; das Handle wird unten geschlossen.
    if let Err(e) =
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token) }
    {
        return format!("Token nicht geöffnet: {}", fehler(&e));
    }
    let mut luid = LUID::default();
    let antwort = match unsafe { LookupPrivilegeValueW(PCWSTR::null(), SE_INC_BASE_PRIORITY_NAME, &mut luid) } {
        Err(e) => format!("unbekannt: {}", fehler(&e)),
        Ok(()) => {
            let tp = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
            };
            // Meldet Erfolg auch, wenn das Recht fehlt — dann steht
            // ERROR_NOT_ALL_ASSIGNED im letzten Fehler.
            match unsafe { AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None) } {
                Err(e) => format!("nicht eingeschaltet: {}", fehler(&e)),
                Ok(()) if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED => {
                    "nicht im Token (ohne Adminrechte normal)".into()
                }
                Ok(()) => "eingeschaltet".into(),
            }
        }
    };
    let _ = unsafe { CloseHandle(token) };
    antwort
}

/// HAGS (hardwarebeschleunigte GPU-Planung) an diesem Adapter — wie Sunshine
/// und OBS über `D3DKMTQueryAdapterInfo(KMTQAITYPE_WDDM_2_7_CAPS)`.
fn hags(luid: LUID) -> Option<bool> {
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
fn grafikspeicher(adapter: &IDXGIAdapter) -> Option<String> {
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

fn fehler(e: &windows::core::Error) -> String {
    format!("{:#010X} {}", e.code().0 as u32, e.message())
}

fn ergebnis(r: windows::core::Result<()>) -> String {
    match r {
        Ok(()) => "ok".into(),
        Err(e) => format!("fehlgeschlagen: {}", fehler(&e)),
    }
}

fn nt(st: NTSTATUS) -> String {
    if st.is_ok() { "ok".into() } else { format!("fehlgeschlagen: NTSTATUS {:#010X}", st.0 as u32) }
}

fn klasse(wert: u32) -> &'static str {
    match wert {
        0x20 => "NORMAL",
        0x40 => "IDLE",
        0x80 => "HIGH",
        0x100 => "REALTIME",
        0x4000 => "BELOW_NORMAL",
        0x8000 => "ABOVE_NORMAL",
        _ => "unbekannt",
    }
}

fn gpu_klasse(k: D3DKMT_SCHEDULINGPRIORITYCLASS) -> &'static str {
    match k.0 {
        0 => "IDLE",
        1 => "BELOW_NORMAL",
        2 => "NORMAL",
        3 => "ABOVE_NORMAL",
        4 => "HIGH",
        5 => "REALTIME",
        _ => "unbekannt",
    }
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

    #[test]
    fn klassennamen() {
        assert_eq!(klasse(ABOVE_NORMAL_PRIORITY_CLASS.0), "ABOVE_NORMAL");
        assert_eq!(gpu_klasse(D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH), "HIGH");
    }
}
