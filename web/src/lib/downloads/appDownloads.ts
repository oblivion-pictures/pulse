/**
 * App-Download-Quellen für die Webseite (Login-Screen + Einstellungen).
 *
 * Wo was liegt (Eigentümer-Entscheid 2026-10-12, Schritt 2 des Umzugs):
 *  - Windows, macOS, Android und die Server-App für Windows/macOS: GitHub
 *    Releases. Jede Desktop-Version bekommt ein Release `desktop-v<version>`
 *    mit FESTEN Dateinamen (`infra/release/github-release.sh`);
 *    `releases/latest/download/<Name>` zeigt auf das jüngste vollständige.
 *  - Linux: Flatpak-Repo auf dem eigenen Server (`/flatpak/`) — kein
 *    Einzeldatei-Download, Installation per
 *    `flatpak install --from <flatpakref>` (oder die .flatpakref-Datei in GNOME
 *    Software öffnen). Das Flatpak bleibt bewusst dort.
 *  - NICHT hierher gehört der Auto-Update-Feed der Windows-/macOS-Apps
 *    (`/updates/win/`, `/updates/win-server/`, `/updates/mac/` …): der liegt
 *    weiter auf dem eigenen Server und wird von electron-updater gelesen,
 *    nicht von Menschen (Schritt 3 des Umzugs, noch offen).
 *
 * Die alten Bequem-Adressen `howispulse.com/updates/win/Pulse-Setup-latest.exe`
 * u. ä. leitet nginx auf dieselben GitHub-Adressen weiter
 * (`infra/prod/web-nginx.conf`) — das README verlinkt sie noch.
 *
 * Absolute URLs (nicht relativ), damit die Links auch aus einer lokalen
 * Dev-Umgebung heraus auf die echten Artefakte zeigen.
 *
 * ACHTUNG — dieselben Konstanten stehen ein zweites Mal in
 * `web/static/landing.js` (Landingpage auf `/`). Die Datei laeuft ohne
 * Bundler und kann hier nicht importieren, also **synchron halten**: wer eine
 * URL hier aendert, aendert sie dort mit (`web/test/landing.test.ts` vergleicht
 * beide). Dieselben Adressen stehen außerdem fest in `web/static/landing.html`
 * (Plattform-Kacheln) und `web/static/native.json` (macOS-Link des Update-
 * Hinweises).
 */

const BASE = 'https://howispulse.com';
const GITHUB_LATEST = 'https://github.com/oblivion-pictures/pulse/releases/latest/download';

export const WINDOWS_INSTALLER_URL = `${GITHUB_LATEST}/Pulse-Setup-Windows.exe`;
export const ANDROID_APK_URL = `${GITHUB_LATEST}/Pulse-Android.apk`;
// macOS: Apple-Silicon .dmg aus dem GitHub-Release (Dateiname fest, s. oben).
export const MAC_DMG_URL = `${GITHUB_LATEST}/Pulse-macOS.dmg`;
export const LINUX_FLATPAKREF_URL = `${BASE}/flatpak/com.howispulse.Pulse.flatpakref`;
export const LINUX_INSTALL_COMMAND = `flatpak install --from ${LINUX_FLATPAKREF_URL}`;

// ── Pulse Server (App-Hosting, seit 0.1.92) ─────────────────────────────────
// Eigenes Server-Hosting aus der App heraus. Windows und macOS kommen wie beim
// Client aus dem GitHub-Release (win-build-server.yml bzw. der build-server-Job
// in mac-build.yml legen sie dort ab); Linux teilt sich das Flatpak-Repo auf
// dem eigenen Server, eigene App-ID com.howispulse.PulseServer.
export const WINDOWS_SERVER_INSTALLER_URL = `${GITHUB_LATEST}/Pulse-Server-Setup-Windows.exe`;
export const MAC_SERVER_DMG_URL = `${GITHUB_LATEST}/Pulse-Server-macOS.dmg`;
export const LINUX_SERVER_FLATPAKREF_URL = `${BASE}/flatpak/com.howispulse.PulseServer.flatpakref`;
export const LINUX_SERVER_INSTALL_COMMAND = `flatpak install --from ${LINUX_SERVER_FLATPAKREF_URL}`;
