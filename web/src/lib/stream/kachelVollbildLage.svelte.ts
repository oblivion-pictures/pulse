/**
 * Steht eine HQ-/Party-Kachel im (selbst gebauten) Vollbild? — der lagetreu
 * Zähler, den `TileShell` bedient und `layoutLage` für die Orientierungs-
 * Freigabe liest: im Kachel-Vollbild muss das Gerät mitdrehen dürfen, sonst
 * „kippt nichts" (Nutzerbefund 2026-10-19 — die Freigabe hing allein am
 * ANGEDOCKTEN Stream, das Vollbild zählte nicht).
 *
 * `.svelte.ts`, weil `layoutLage` reaktiv daraus ableitet. Kleine Zahlen,
 * wenige Wechsel — kein Stau zu erwarten.
 *
 * **An- und Abmelden lesen den Zähler `untrack`** (seit 2026-10-28). Gerufen
 * werden sie aus einem `$effect` (`TileShell`); `offen += 1` liest `offen` dort
 * mit, der Effekt hing dadurch an seinem eigenen Schreiben — abmelden,
 * anmelden, wieder von vorn, bis Svelte mit `effect_update_depth_exceeded`
 * abbrach. Danach stand die Kachel: am Rechner blieb sie nach Esc im
 * Vollbild-Zustand, Schliessen und Lautstärke wirkten nicht mehr (gemessen in
 * der Electron-Dev-App per DevTools-Protokoll).
 */
import { untrack } from 'svelte';

let offen = $state(0);

export const kachelVollbildLage = {
  get offen(): number {
    return offen;
  },
  anmelden(): void {
    untrack(() => {
      offen += 1;
    });
  },
  abmelden(): void {
    untrack(() => {
      offen = Math.max(0, offen - 1);
    });
  }
};
