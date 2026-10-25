/**
 * Autostart beim Anmelden (Server-App).
 *
 *  - Win/Mac: `app.setLoginItemSettings` (per Dep injiziert — dieses Modul
 *    bleibt electron-frei für node:test).
 *  - Linux: XDG-Autostart-Datei nach `~/.config/autostart/` — das Server-
 *    Flatpak gibt genau dieses Verzeichnis frei (`--filesystem=xdg-config/
 *    autostart:create`; bis 2026-10-08 `--filesystem=host`), es ist also
 *    DIREKT beschreibbar (kein Background-Portal/D-Bus nötig; Electron hat dafür
 *    ohnehin keine API und neue Dependencies sind tabu). Exec-Zeile im
 *    Flatpak = `flatpak run <app-id>`, sonst der Electron-Binary-Pfad.
 *
 * Der Schalter-Zustand lebt im Store (`serverAutostart`); diese Funktionen
 * setzen nur den OS-Zustand um — idempotent, damit der Boot-Pfad sie bei
 * jedem Start zum Abgleich aufrufen kann.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FLATPAK_SERVER_APP_ID = 'com.howispulse.PulseServer';

/** Exec-Zeile für die .desktop-Datei. execPath in Anführungszeichen —
 *  Installationspfade mit Leerzeichen sind sonst kaputte Exec-Keys. Der
 *  `--autostarted`-Schalter teilt der App mit, dass sie per Autostart kam —
 *  sie zeigt dann einmalig eine Hintergrund-Benachrichtigung (der Daemon
 *  startet ohne Fenster, sonst wäre er komplett unsichtbar). */
export function linuxExecLine(flatpak: boolean, execPath: string): string {
  return flatpak
    ? `flatpak run ${FLATPAK_SERVER_APP_ID} --autostarted`
    : `"${execPath}" --autostarted`;
}

/** Inhalt der XDG-Autostart-Datei. X-Flatpak markiert den Eintrag als
 *  Flatpak-verwaltet (Desktop-Umgebungen zeigen ihn dann korrekt an). */
export function autostartDesktopEntry(execLine: string, flatpak: boolean): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Pulse Server',
    `Exec=${execLine}`,
    'X-GNOME-Autostart-enabled=true',
  ];
  if (flatpak) lines.push(`X-Flatpak=${FLATPAK_SERVER_APP_ID}`);
  return lines.join('\n') + '\n';
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  /** app.isPackaged. Ungepackt (`pnpm dev`) ist execPath der nackte Electron-
   *  Binary aus node_modules: ein Eintrag damit startet beim Anmelden nur
   *  Electrons Default-App („electron path-to-app“) statt Pulse. Auch das
   *  Flatpak meldet false (es startet /app/electron/electron mit Verzeichnis),
   *  braucht execPath aber nicht — `flatpak` hebt die Sperre deshalb auf. */
  packaged: boolean;
  /** Win/Mac: app.setLoginItemSettings({ openAtLogin }) — injiziert. */
  setLoginItems(openAtLogin: boolean): void;
  flatpak: boolean;
  execPath: string;
  home: string;
}

/** OS-Autostart setzen/entfernen. Fehler → ok:false (UI zeigt den Schalter
 *  dann als nicht übernommen), nie ein throw. */
export function applyAutostart(enabled: boolean, deps: AutostartDeps): { ok: boolean } {
  // Ungepackt (außer Flatpak) kein OS-Zustand, auch kein Entfernen: die
  // Linux-Datei teilt ihren Namen mit der installierten App, ein Dev-Lauf
  // löschte sonst deren Eintrag. Win/Mac registrieren ungepackt ebenso
  // Electron statt Pulse (aus der Electron-Doku gefolgert, nicht gemessen).
  if (!deps.packaged && !deps.flatpak) return { ok: false };
  try {
    if (deps.platform === 'win32' || deps.platform === 'darwin') {
      deps.setLoginItems(enabled);
      return { ok: true };
    }
    if (deps.platform !== 'linux') return { ok: false };
    const dir = join(deps.home, '.config', 'autostart');
    const file = join(dir, 'pulse-server.desktop');
    if (enabled) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, autostartDesktopEntry(linuxExecLine(deps.flatpak, deps.execPath), deps.flatpak), 'utf8');
    } else {
      rmSync(file, { force: true });
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
