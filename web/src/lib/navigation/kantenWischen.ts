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

// ── Fingerfolgen: die Seite wandert mit dem Finger ──────────────────────────

/** Ab welchem Tempo (px/ms, also 500 px/s) ein Wisch ein Flick ist. */
export const FLICK_TEMPO = 0.5;
/** Ein Flick löst erst ab dieser Strecke (px) aus — kein Zucken am Rand. */
export const FLICK_MIN_WEG = 24;
/** Wie lange (ms) die Proben für das Tempo zurückreichen. */
export const TEMPO_FENSTER_MS = 100;
/** Dauer (ms) des Hinausgleitens bzw. Zurückfederns. */
export const FEDER_MS = 250;
/** Die Feder-Kurve der Seitenwechsel (dieselbe wie in `app.css`). */
export const FEDER_KURVE = 'cubic-bezier(0.32,0.72,0,1)';

/** Wie weit die Seite dem Finger folgt: nie nach links, nie über die Breite. */
export function folgeWeg(dx: number, breite: number): number {
  return Math.min(Math.max(dx, 0), Math.max(breite, 0));
}

export type Probe = { x: number; t: number };

/**
 * Tempo (px/ms) aus den jüngsten Proben: vom ältesten Wert innerhalb von
 * {@link TEMPO_FENSTER_MS} vor der letzten Probe bis zur letzten. Weniger als
 * zwei Proben oder keine verstrichene Zeit → 0.
 */
export function tempoAus(proben: readonly Probe[]): number {
  const letzte = proben[proben.length - 1];
  if (!letzte) return 0;
  const erste = proben.find((p) => letzte.t - p.t <= TEMPO_FENSTER_MS);
  if (!erste || letzte.t <= erste.t) return 0;
  return (letzte.x - erste.x) / (letzte.t - erste.t);
}

export type Ausgang = 'hinaus' | 'zurueckfedern';

/**
 * Was beim Loslassen mit der mitgezogenen Seite geschieht: ab einem Drittel
 * der Breite oder als schneller Flick (nach rechts, mindestens
 * {@link FLICK_MIN_WEG}) gleitet sie hinaus, sonst federt sie zurück. Eine
 * Bewegung, die nicht mehr eindeutig waagrecht ist, federt immer zurück.
 */
export function ausgang(dx: number, dy: number, tempo: number, breite: number): Ausgang {
  if (verlauf(dx, dy) !== 'waagrecht') return 'zurueckfedern';
  if (dx >= breite / 3) return 'hinaus';
  return tempo >= FLICK_TEMPO && dx >= FLICK_MIN_WEG ? 'hinaus' : 'zurueckfedern';
}
