//! **Eine** wgpu-Instanz für den ganzen Prozess, nie zerstört.
//!
//! **Der Absturz, um den es geht** (2026-10-16, nachgestellt und belegt): mit
//! mehreren Player-Fenstern unter Wayland auf NVIDIA (Treiber 615.71.09 und
//! 615.78.08) stürzte der Player beim Abbau eines Fensters mit SIGSEGV ab —
//! Aufruf an Adresse 0 im Hauptfaden, aus `vkDestroySwapchainKHR` heraus. Alle
//! anderen Fenster verschwanden mit. Ursache im Treiber: `libnvidia-glcore`
//! hält die per `dlopen` geholten `wl_proxy_*`-Funktionen in EINER globalen
//! Tabelle, legt aber je Instanz ein eigenes Wayland-Objekt an; dessen
//! Destruktor ruft `dlclose` und nullt die ganze Tabelle. Wird also die
//! `VkInstance` EINES Fensters zerstört, greift jedes andere Fenster bei seinem
//! nächsten Swapchain-Aufruf ins Leere.
//!
//! **Bis hierher bekam jedes Fenster seine eigene Instanz** (`setup::create`),
//! und sie fiel mit dem Fenster. Der Absturz kam allerdings nicht bei jedem
//! Schliessen: hielt die noch laufende Sitzung die Instanz über ihr Gerät
//! fest, fiel sie erst, wenn die Sitzung endete — daher die 0,6–1 s
//! Verzögerung in den Protokollen, und daher stürzte das Schliessen einer
//! Sitzung, die schon von selbst gescheitert war („Verbindung abgerissen"),
//! sofort ab.
//!
//! **Nachweis:** Zwei Fenster gegen einen WHEP-Endpunkt, der nach 1,5 s
//! abbricht — 6 von 6 Läufen SIGSEGV; dieselbe Instanz festgehalten: 0 von 6;
//! ein Fenster: 0 von 4. Das Gerät je Fenster durfte dabei weiter fallen, es
//! braucht also nur die Instanz. Werkzeug: `scripts/mehrfenster-absturz.py`.
//!
//! **Gebunden an die Anzeige-Verbindung, nicht an ein Fenster.** Wayland
//! verlangt die Anzeige schon beim Anlegen der Instanz. Bekäme sie dafür das
//! erste Fenster, hielte die Instanz dieses Fenster für immer am Leben — es
//! ginge nicht mehr zu. `OwnedDisplayHandle` ist die Verbindung selbst.

use std::sync::OnceLock;

static INSTANZ: OnceLock<wgpu::Instance> = OnceLock::new();

/// Die Instanz des Prozesses — beim ersten Aufruf angelegt, danach dieselbe.
/// `&'static`: sie liegt im `static` und fällt nie.
pub fn gemeinsam(anzeige: &winit::event_loop::OwnedDisplayHandle) -> &'static wgpu::Instance {
    INSTANZ.get_or_init(|| {
        wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: super::setup::backends(),
            ..wgpu::InstanceDescriptor::new_with_display_handle_from_env(Box::new(anzeige.clone()))
        })
    })
}
