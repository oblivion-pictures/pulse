/**
 * Was ein gescheiterter `navigator.share({ files })` bedeutet — importfrei,
 * damit der Node-Läufer die Rechnung prüft (`dateiTeilen.ts` zieht den
 * `$lib`-Alias nach).
 *
 * - `abbruch`: der Nutzer hat das Blatt geschlossen — in Ordnung, nichts zu sagen.
 * - `geste`: `NotAllowedError`, die Nutzeraktivierung war nach dem Holen der
 *   Datei schon verbraucht. Die Datei ist da; ein neuer Tipp macht es möglich.
 * - `fehler`: alles andere.
 */
export type TeilenFehlerArt = 'abbruch' | 'geste' | 'fehler';

export function teilenFehlerArt(e: unknown): TeilenFehlerArt {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'AbortError') return 'abbruch';
  if (name === 'NotAllowedError') return 'geste';
  return 'fehler';
}
