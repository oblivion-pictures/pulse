// Marke „für diesen Code ging schon eine Entscheidung hinaus“ — damit die
// Bestätigungsseite einen Fehlschlag der Anfrage von einem Erfolg unterscheiden
// kann, dessen Antwort sie nie gesehen hat. Importfrei bis auf die Nachbarn
// (Node-Unit-Tests).
//
// Das Bestätigen dauert in der Cloud bis ~30 s (sie verschickt die Hinweis-Mails
// inline). Reißt in dieser Zeit die Verbindung ab, oder lädt der Nutzer
// ungeduldig neu, hat der erste Klick trotzdem gewirkt — der Code ist
// verbraucht, und jede weitere Anfrage bekommt 404. Ohne diese Marke läse die
// Seite das als „Dieser Code gilt nicht mehr“ und der Betreiber hielte seinen
// geglückten Server für gescheitert.
//
// sessionStorage statt localStorage: die Marke gehört zu diesem Tab, ein
// Neuladen übersteht sie, ein zweiter Tab oder ein späterer Besuch sieht sie
// nicht. 15 Minuten wie der Code selbst.
import { codeNormalisieren } from './code.ts';
import type { Speicher } from './gemerkt.ts';

export const SPEICHER_SCHLUESSEL = 'pulse.verbinden.abgeschickt';
export const HALTBARKEIT_MS = 15 * 60 * 1000;

export function abschickenMerken(s: Speicher | null, code: string, jetzt: number): void {
  if (!s) return;
  const c = codeNormalisieren(code);
  if (!c) return;
  try {
    s.setItem(SPEICHER_SCHLUESSEL, JSON.stringify({ code: c, am: jetzt }));
  } catch {
    /* voll oder gesperrt — dann deutet die Seite einen Fehlversuch eben nüchtern */
  }
}

export function abschickenVergessen(s: Speicher | null): void {
  if (!s) return;
  try {
    s.removeItem(SPEICHER_SCHLUESSEL);
  } catch {
    /* gesperrt — es gibt nichts zu tun */
  }
}

/** Ging für DIESEN Code in den letzten 15 Minuten eine Entscheidung hinaus,
 *  deren Ausgang die Seite nicht kennt? Eine verfallene oder kaputte Marke
 *  wird dabei gelöscht. */
export function warAbgeschickt(s: Speicher | null, code: string, jetzt: number): boolean {
  if (!s) return false;
  const gesucht = codeNormalisieren(code);
  if (!gesucht) return false;
  let roh: string | null;
  try {
    roh = s.getItem(SPEICHER_SCHLUESSEL);
  } catch {
    return false;
  }
  if (roh === null) return false;
  const gemerkt = lesen(roh, jetzt);
  if (!gemerkt) abschickenVergessen(s);
  return gemerkt === gesucht;
}

function lesen(roh: string, jetzt: number): string | null {
  let d: unknown;
  try {
    d = JSON.parse(roh);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null) return null;
  const { code, am } = d as Record<string, unknown>;
  if (typeof code !== 'string' || typeof am !== 'number') return null;
  const alter = jetzt - am;
  if (!(alter >= 0 && alter < HALTBARKEIT_MS)) return null;
  return codeNormalisieren(code);
}

/** Ein Speicher im Arbeitsspeicher — der Rückfall, wenn schon der Zugriff auf
 *  `sessionStorage` wirft. Er trägt kein Neuladen, aber einen zweiten Klick. */
export function imSpeicherAnlegen(): Speicher {
  const daten = new Map<string, string>();
  return {
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k)
  };
}

const rueckfall = imSpeicherAnlegen();

/** `sessionStorage` dieses Tabs, sonst der Arbeitsspeicher. Nie `null`. */
export function tabSpeicher(): Speicher {
  try {
    return typeof sessionStorage === 'undefined' ? rueckfall : sessionStorage;
  } catch {
    return rueckfall;
  }
}
