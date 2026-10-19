/**
 * Steht eine HQ-/Party-Kachel im (selbst gebauten) Vollbild? — der lagetreu
 * Zähler, den `TileShell` bedient und `layoutLage` für die Orientierungs-
 * Freigabe liest: im Kachel-Vollbild muss das Gerät mitdrehen dürfen, sonst
 * „kippt nichts" (Nutzerbefund 2026-10-19 — die Freigabe hing allein am
 * ANGEDOCKTEN Stream, das Vollbild zählte nicht).
 *
 * `.svelte.ts`, weil `layoutLage` reaktiv daraus ableitet. Kleine Zahlen,
 * wenige Wechsel — kein Stau zu erwarten.
 */
let offen = $state(0);

export const kachelVollbildLage = {
  get offen(): number {
    return offen;
  },
  anmelden(): void {
    offen += 1;
  },
  abmelden(): void {
    offen = Math.max(0, offen - 1);
  }
};
