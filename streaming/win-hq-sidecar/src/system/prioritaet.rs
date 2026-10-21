//! Vorrang während einer Fernsteuerung: Prozess-, Faden- und GPU-Priorität.
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
//! **Zuordnung: nur während einer Fernsteuerung** (Eigentümer-Entscheid
//! 2026-10-21: die Änderungen dieses Tages sollen das normale Streamen nicht
//! berühren). [`streamen`] legt beim Start des Pipeline-Fadens nur den Wächter
//! an; gehoben wird erst, wenn [`abgleichen`] — je Takt aus allen drei
//! Pipeline-Schleifen gerufen — eine laufende Fernsteuerung sieht, und mit
//! ihrem Ende wieder auf den vorigen Stand gesenkt. Der Wächter senkt beim
//! Stream-Ende auch dann, wenn die Fernsteuerung noch lief — wie Sunshines
//! `streaming_will_stop`. Im Direktmodus lebt der Prozess danach im
//! Wartezustand weiter und soll dort nicht bevorzugt laufen.
//!
//! **Jeder Bildschirm ist ein eigener Sidecar-Prozess**, die Klassen hier sind
//! also je Strom und brauchen keine Zählung über mehrere Pipelines.
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
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Wdk::Graphics::Direct3D::{
    D3DKMT_SCHEDULINGPRIORITYCLASS, D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH,
    D3DKMTGetProcessSchedulingPriorityClass, D3DKMTSetProcessSchedulingPriorityClass,
};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, LUID, NTSTATUS,
};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Security::{
    AdjustTokenPrivileges, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW, SE_INC_BASE_PRIORITY_NAME,
    SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    ABOVE_NORMAL_PRIORITY_CLASS, GetCurrentProcess, GetCurrentThread, GetPriorityClass,
    OpenProcessToken, PROCESS_CREATION_FLAGS, SetPriorityClass, SetThreadPriority,
    THREAD_PRIORITY_ABOVE_NORMAL, THREAD_PRIORITY_NORMAL,
};
use windows::core::{Interface, PCWSTR};

use super::gpu_lage;

/// `0` schaltet das ganze Modul ab (A/B-Vergleich), Vorgabe an.
pub const UMGEBUNG: &str = "PULSE_HQ_PRIORITAET";
/// Höchstwert von `SetGPUThreadPriority` (Bereich -7..=7), wie Sunshine.
const GPU_FADEN: i32 = 7;

/// Was gerade gehoben ist und wie es vorher war — ein Stand je Prozess, weil
/// Prozess- und GPU-Klasse am Prozess hängen.
struct Zustand {
    gehoben: bool,
    recht_gemeldet: bool,
    cpu_vorher: Option<u32>,
    gpu_vorher: Option<D3DKMT_SCHEDULINGPRIORITYCLASS>,
    /// Die Geräte, die [`geraet`] gemeldet hat; `SetGPUThreadPriority` hängt
    /// am Gerät und wird mit der Fernsteuerung an- und abgeschaltet.
    geraete: Vec<Geraet>,
}

struct Geraet {
    dxgi: IDXGIDevice,
    wofuer: &'static str,
}

// SAFETY: D3D11-Geräte sind frei-fädig, solange sie nicht mit
// `D3D11_CREATE_DEVICE_SINGLETHREADED` angelegt wurden — die Aufnahme-Geräte
// entstehen in `vendor/windows-capture/src/d3d11.rs` nur mit `BGRA_SUPPORT` —,
// und `SetGPUThreadPriority` ist eine Methode des Geräts, nicht seines
// Kontexts. Gemeldet wird teils vom Aufnahme-Faden (D3D12-Weg), geschaltet
// vom Pipeline-Faden.
unsafe impl Send for Geraet {}

static ZUSTAND: Mutex<Zustand> = Mutex::new(Zustand {
    gehoben: false,
    recht_gemeldet: false,
    cpu_vorher: None,
    gpu_vorher: None,
    geraete: Vec::new(),
});

fn an() -> bool {
    crate::env::flag_default_on(UMGEBUNG)
}

/// Ein Wächter lebt ([`streamen`]). Hält [`abgleichen`] billig — es läuft je
/// Takt und liest die Umgebung so nicht jedes Mal neu — und ohne Wächter
/// still, weil sonst niemand das Gehobene wieder senken würde.
static BEREIT: AtomicBool = AtomicBool::new(false);

/// Wächter aus [`streamen`]: senkt beim Fallenlassen, falls noch gehoben.
#[must_use = "beim Fallenlassen wird die Priorität zurückgesetzt"]
pub struct Vorrang(());

/// Wächter für die Dauer eines Stroms anlegen. Auf dem Pipeline-Faden rufen —
/// er ist zugleich der Taktfaden, und [`abgleichen`] hebt den RUFENDEN Faden.
/// `None`, wenn per [`UMGEBUNG`] abgeschaltet.
pub fn streamen() -> Option<Vorrang> {
    if !an() {
        eprintln!("[prioritaet] aus ({UMGEBUNG}=0): Prozess, Faden und GPU bleiben auf Normal");
        return None;
    }
    eprintln!("[prioritaet] bereit: angehoben wird nur während einer Fernsteuerung");
    BEREIT.store(true, Ordering::Relaxed);
    Some(Vorrang(()))
}

impl Drop for Vorrang {
    fn drop(&mut self) {
        BEREIT.store(false, Ordering::Relaxed);
        let Ok(mut z) = ZUSTAND.lock() else { return };
        if z.gehoben {
            senken(&mut z, "Stream-Ende");
        }
        z.geraete.clear();
    }
}

/// Je Takt aus den Pipeline-Schleifen (`pipeline_hw`, `pipeline_d3d12`,
/// `cpu_pipeline`), **nur auf dem Pipeline-Faden**: hebt mit dem Beginn einer
/// Fernsteuerung an und senkt mit ihrem Ende. Ohne Wechsel ein Vergleich.
pub fn abgleichen() {
    if !BEREIT.load(Ordering::Relaxed) {
        return;
    }
    let fern = crate::remote_input::fern_aktiv();
    let Ok(mut z) = ZUSTAND.lock() else { return };
    if fern == z.gehoben {
        return;
    }
    if fern { heben(&mut z) } else { senken(&mut z, "Fernsteuerung beendet") }
}

fn heben(z: &mut Zustand) {
    z.gehoben = true;
    if !z.recht_gemeldet {
        z.recht_gemeldet = true;
        eprintln!("[prioritaet] Recht SeIncreaseBasePriority: {}", recht_einschalten());
    }
    // SAFETY: Pseudo-Handles des eigenen Prozesses/Fadens, nie ungültig.
    let vorher = unsafe { GetPriorityClass(GetCurrentProcess()) };
    z.cpu_vorher = match unsafe { SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS) } {
        Ok(()) => {
            eprintln!("[prioritaet] Fernsteuerung: Prozess ABOVE_NORMAL (vorher {}) ok", klasse(vorher));
            (vorher != 0).then_some(vorher)
        }
        Err(e) => {
            eprintln!("[prioritaet] Fernsteuerung: Prozess ABOVE_NORMAL fehlgeschlagen: {}", fehler(&e));
            None
        }
    };
    let faden = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL) };
    eprintln!("[prioritaet] Fernsteuerung: Taktfaden ABOVE_NORMAL {}", ergebnis(faden));
    let mut alt = D3DKMT_SCHEDULINGPRIORITYCLASS::default();
    // SAFETY: Pseudo-Handle des eigenen Prozesses; `alt` ist ein gültiges Ziel.
    let gelesen = unsafe { D3DKMTGetProcessSchedulingPriorityClass(GetCurrentProcess(), &mut alt) };
    let st = unsafe {
        D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess(), D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH)
    };
    let war = if gelesen.is_ok() { gpu_klasse(alt) } else { "unbekannt" };
    eprintln!("[prioritaet] Fernsteuerung: GPU-Planungsklasse HIGH (vorher {war}) {}", nt(st));
    z.gpu_vorher = (st.is_ok() && gelesen.is_ok()).then_some(alt);
    for g in &z.geraete {
        geraet_schalten(g, GPU_FADEN);
    }
}

fn senken(z: &mut Zustand, warum: &str) {
    z.gehoben = false;
    if let Some(alt) = z.cpu_vorher.take() {
        let r = unsafe { SetPriorityClass(GetCurrentProcess(), PROCESS_CREATION_FLAGS(alt)) };
        eprintln!("[prioritaet] zurück ({warum}): Prozess {} {}", klasse(alt), ergebnis(r));
    }
    let faden = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL) };
    eprintln!("[prioritaet] zurück ({warum}): Taktfaden NORMAL {}", ergebnis(faden));
    if let Some(alt) = z.gpu_vorher.take() {
        let st = unsafe { D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess(), alt) };
        eprintln!("[prioritaet] zurück ({warum}): GPU-Klasse {} {}", gpu_klasse(alt), nt(st));
    }
    for g in &z.geraete {
        geraet_schalten(g, 0);
    }
}

fn geraet_schalten(g: &Geraet, wert: i32) {
    let r = unsafe { g.dxgi.SetGPUThreadPriority(wert) };
    eprintln!("[prioritaet] Gerät {}: SetGPUThreadPriority({wert}) {}", g.wofuer, ergebnis(r));
}

/// Ein D3D11-Gerät für die GPU-Stufe anmelden; dazu HAGS und Grafikspeicher in
/// die Logzeile — beides Kandidaten für die Ursache des Hängers, und beim
/// Start gemeldet, auch wenn (noch) nicht gesteuert wird. Läuft schon eine
/// Fernsteuerung, wird das Gerät sofort gehoben.
pub fn geraet(device: &ID3D11Device, wofuer: &'static str) {
    if !an() {
        return;
    }
    let dxgi: IDXGIDevice = match device.cast() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[prioritaet] Gerät {wofuer}: kein IDXGIDevice: {}", fehler(&e));
            return;
        }
    };
    let adapter = unsafe { dxgi.GetAdapter() }.ok();
    let desc = adapter.as_ref().and_then(|a| unsafe { a.GetDesc() }.ok());
    let hags = match desc.as_ref().and_then(|d| gpu_lage::hags(d.AdapterLuid)) {
        Some(true) => "an",
        Some(false) => "aus",
        None => "unbekannt",
    };
    let speicher =
        adapter.as_ref().and_then(gpu_lage::grafikspeicher).unwrap_or_else(|| "unbekannt".into());
    eprintln!("[prioritaet] Gerät {wofuer}: HAGS {hags}; Grafikspeicher {speicher}");
    let Ok(mut z) = ZUSTAND.lock() else { return };
    let g = Geraet { dxgi, wofuer };
    if z.gehoben {
        geraet_schalten(&g, GPU_FADEN);
    }
    z.geraete.push(g);
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
    fn klassennamen() {
        assert_eq!(klasse(ABOVE_NORMAL_PRIORITY_CLASS.0), "ABOVE_NORMAL");
        assert_eq!(gpu_klasse(D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH), "HIGH");
    }
}
