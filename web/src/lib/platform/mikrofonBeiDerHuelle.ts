/**
 * Gehört das Mikrofon gerade der iOS-Hülle? Dann darf die WebView keins
 * öffnen.
 *
 * **Der Fehlerfall, gegen den das steht.** Hält die Hülle einen nativen Raum
 * (Sprachkanal oder Anruf), nimmt sie über LiveKit auf — in der Audio-Session
 * der App. Ein `getUserMedia` der WebView richtet daneben WebKits eigene
 * Aufnahme-Session ein, und eine Aufnahme ist nicht mischbar: iOS unterbricht
 * die Session der Hülle, das Mikrofon im Kanal ist weg. Dieselbe Fehlerklasse
 * wie der Beitrittston vom 2026-10-10 (Messung an `webSessionTyp` in
 * `iosSprache.ts`), dort mit einem Ton statt einer Aufnahme. **Gefolgert, nicht
 * gemessen**: der Mac hat kein Mikrofon, der Simulator also auch nicht.
 *
 * Gemeldet wird allein aus `iosSprache.ts`, an derselben Stelle, an der WebKits
 * `ambient` kippt — genau so lange, wie ein nativer Raum steht. Ausserhalb der
 * iOS-Hülle meldet niemand, der Stand bleibt `false`.
 *
 * Importfrei, damit Nodes Läufer es prüfen kann (CLAUDE.md, `pnpm test:unit`).
 */

let beiDerHuelle = false;
const hoerer = new Set<(an: boolean) => void>();

/** Nur aus `iosSprache.ts`. Ruft die Hörer nur beim Wechsel. */
export function mikrofonBeiDerHuelleMelden(an: boolean): void {
  if (an === beiDerHuelle) return;
  beiDerHuelle = an;
  for (const h of [...hoerer]) h(an);
}

export function mikrofonBeiDerHuelle(): boolean {
  return beiDerHuelle;
}

/** Auf Wechsel hören. Rückgabe meldet ab. */
export function mikrofonBeiDerHuelleBeobachten(h: (an: boolean) => void): () => void {
  hoerer.add(h);
  return () => hoerer.delete(h);
}
