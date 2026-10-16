//! Die Kennung, unter der sich das Player-Fenster beim Fenstermanager meldet.
//!
//! Unter Linux sucht eine Taskleiste das Symbol eines Fensters über dessen
//! Kennung: Wayland-`app_id` bzw. X11-`WM_CLASS`, gegen den Namen einer
//! `.desktop`-Datei. Ohne Kennung (bis 0.1.118) meldete `niri msg windows` für
//! den Player `App ID: (unset)`, und die Leiste zeigte kein Symbol.
//!
//! **Eigene Kennung, nicht die der App** (`com.howispulse.Pulse`): mit dieser
//! fände die Leiste das Symbol zwar ohne weitere Datei, zählte den Player aber
//! als zweites Fenster der App, statt ihm einen eigenen Eintrag zu geben. Den
//! Eintrag samt Symbol liefert `packaging/com.howispulse.Pulse.Player.desktop`
//! (`NoDisplay`, `Icon=com.howispulse.Pulse`), die das Flatpak mitinstalliert.
//! Ein Player außerhalb des Flatpaks (Entwicklung) hat diese Datei nicht und
//! bleibt deshalb ohne Symbol, meldet aber dieselbe Kennung.

use winit::window::WindowAttributes;

/// Muss gleich dem Dateinamen der `.desktop`-Datei (ohne Endung) und deren
/// `StartupWMClass` sein, sonst findet die Leiste das Symbol nicht.
#[cfg(target_os = "linux")]
const KENNUNG: &str = "com.howispulse.Pulse.Player";

/// Wayland und X11 schreiben in winit 0.30 in dasselbe Feld
/// (`platform_specific.name`), ein Aufruf deckt also beide ab.
#[cfg(target_os = "linux")]
pub(super) fn mit_kennung(attrs: WindowAttributes) -> WindowAttributes {
    use winit::platform::wayland::WindowAttributesExtWayland;
    attrs.with_name(KENNUNG, KENNUNG)
}

/// Windows und macOS ordnen Fenster über den Prozess zu, nicht über eine Kennung.
#[cfg(not(target_os = "linux"))]
pub(super) fn mit_kennung(attrs: WindowAttributes) -> WindowAttributes {
    attrs
}
