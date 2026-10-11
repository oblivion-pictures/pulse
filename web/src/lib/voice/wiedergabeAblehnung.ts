/**
 * Abgelehnte Wiedergabe eines fremden Tonelements deuten
 * (`audioElements.ts::attach`). Importfrei, damit `pnpm test:unit` die
 * Entscheidung direkt prüft (`test/wiedergabe-ablehnung.test.ts`).
 */

/** Name eines abgelehnten Promise, robust gegen alles, was kein Error ist. */
export function fehlerName(e: unknown): string {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' && n ? n : 'unbekannt';
}

/**
 * Eine abgelehnte `play()` deuten — und nur im echten Fall sperren.
 *
 * **Bis zum 2026-10-10 galt JEDE Ablehnung als Autoplay-Sperre**, und die
 * Oberflaeche sagte dazu „Dein Browser blockiert die automatische
 * Wiedergabe". Das traf oft nicht zu: wir setzen `autoplay = true` UND rufen
 * `play()`, und wenn die implizite Wiedergabe und dieser Ruf einander
 * ueberholen, wirft WebKit regulaer `AbortError`. Eine Sperre ist allein
 * `NotAllowedError`.
 *
 * Alles andere bekommt genau einen zweiten Anlauf — die Ueberholung ist
 * voruebergehend. Erst wenn auch der scheitert, gilt es als Sperre, und der
 * NAME reist mit, damit die naechste Fehlersuche nicht wieder bei null
 * anfaengt.
 */
export function wiedergabeFehlschlag(
  anchor: { play(): Promise<void> },
  fehler: unknown,
  onBlocked: (grund: string) => void,
): void {
  const name = fehlerName(fehler);
  if (name === 'NotAllowedError') {
    onBlocked(name);
    return;
  }
  void anchor.play().catch((zweiter: unknown) => onBlocked(`${name} → ${fehlerName(zweiter)}`));
}
