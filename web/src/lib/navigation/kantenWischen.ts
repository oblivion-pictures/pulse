/**
 * Die Rechnung hinter dem Zurückwischen vom linken Rand (iOS-Hülle,
 * `platform/zurueckWischen.ts`). Importfrei und damit prüfbar.
 *
 * Eine Wischgeste „zurück" ist nur eine, wenn sie am Rand BEGINNT, eindeutig
 * waagrecht verläuft und weit genug geht. Alles andere gehört dem Inhalt:
 * senkrechtes Scrollen, Schieber, waagrecht scrollende Flächen.
 */

/** Wie nah am linken Rand (px) eine Berührung beginnen muss. */
export const KANTE = 20;
/** Ab welcher waagrechten Strecke (px) die Geste auslöst. */
export const AUSLOESE_WEG = 60;
/** Ab welcher Strecke (px) entschieden wird, ob die Geste waagrecht ist. */
export const ENTSCHEIDUNG_AB = 10;

export function anDerKante(x: number): boolean {
  return x >= 0 && x <= KANTE;
}

export type Verlauf = 'offen' | 'waagrecht' | 'abgebrochen';

/**
 * Wie die Bewegung seit dem Start zu lesen ist.
 *
 * Nach rechts (dx > 0) und deutlich waagrechter als senkrecht → `waagrecht`.
 * Zu früh zum Entscheiden → `offen`. Nach links oder überwiegend senkrecht →
 * `abgebrochen` (das Scrollen soll nicht gestört werden).
 */
export function verlauf(dx: number, dy: number): Verlauf {
  const weg = Math.max(Math.abs(dx), Math.abs(dy));
  if (weg < ENTSCHEIDUNG_AB) return 'offen';
  if (dx <= 0) return 'abgebrochen';
  return dx > Math.abs(dy) * 1.5 ? 'waagrecht' : 'abgebrochen';
}

/** Löst das Loslassen bei dieser Strecke aus? */
export function ausgeloest(dx: number, dy: number): boolean {
  return verlauf(dx, dy) === 'waagrecht' && dx >= AUSLOESE_WEG;
}
