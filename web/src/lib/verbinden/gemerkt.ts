// Gemerkter Verbindungs-Code — der Rückweg der Bestätigungsseite `/verbinden`
// über Anmelden und Registrieren. Muster: `lib/einladung/gemerkt.ts`.
// Importfrei bis auf den Nachbarn (Node-Unit-Tests).
//
// Warum nicht über die Adresse (`/login?redirect=/verbinden#CODE`): der Code
// steht absichtlich hinter `#`, damit er in keinem Server-Protokoll landet
// (Spec E5). Als Teil von `?redirect=` stünde er in der Adresse der
// Anmeldeseite — und die fordert der Browser beim Server an. Die Anmeldung
// bekommt deshalb nur `?redirect=/verbinden`, der Code wartet hier.
//
// 15 Minuten wie der Code selbst: ein älterer Eintrag ist an der Cloud ohnehin
// verfallen.
import { codeNormalisieren } from './code.ts';

export const SPEICHER_SCHLUESSEL = 'pulse.verbinden.gemerkt';
export const HALTBARKEIT_MS = 15 * 60 * 1000;

export type Speicher = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function verbindungMerken(s: Speicher | null, code: string, jetzt: number): void {
  if (!s) return;
  const c = codeNormalisieren(code);
  if (!c) return;
  try {
    s.setItem(SPEICHER_SCHLUESSEL, JSON.stringify({ code: c, gemerktAm: jetzt }));
  } catch {
    /* voll oder gesperrt — dann eben ohne Rückweg */
  }
}

export function gemerkteVerbindungVerwerfen(s: Speicher | null): void {
  if (!s) return;
  try {
    s.removeItem(SPEICHER_SCHLUESSEL);
  } catch {
    /* gesperrt — es gibt nichts zu tun */
  }
}

/** Der gemerkte Code in Anzeigeform. Alles Ungültige (kaputt, abgelaufen, aus
 *  der Zukunft) wird dabei gelöscht. */
export function gemerkteVerbindung(s: Speicher | null, jetzt: number): string | null {
  if (!s) return null;
  let roh: string | null;
  try {
    roh = s.getItem(SPEICHER_SCHLUESSEL);
  } catch {
    return null;
  }
  if (roh === null) return null;
  const code = lesen(roh, jetzt);
  if (!code) gemerkteVerbindungVerwerfen(s);
  return code;
}

/** Der gemerkte Code, und danach ist er weg: wer angemeldet auf `/verbinden`
 *  weitermacht, hat ihn eingelöst — auch wenn die Adresse einen eigenen Code
 *  trägt und er gar nicht gebraucht wurde. Bliebe er stehen, holte die
 *  Startseite (`routes/app/+page.svelte`) später auf einen alten Code zurück. */
export function gemerkteVerbindungEinloesen(s: Speicher | null, jetzt: number): string | null {
  const code = gemerkteVerbindung(s, jetzt);
  gemerkteVerbindungVerwerfen(s);
  return code;
}

function lesen(roh: string, jetzt: number): string | null {
  let d: unknown;
  try {
    d = JSON.parse(roh);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null) return null;
  const { code, gemerktAm } = d as Record<string, unknown>;
  if (typeof code !== 'string' || typeof gemerktAm !== 'number') return null;
  const alter = jetzt - gemerktAm;
  if (!(alter >= 0 && alter < HALTBARKEIT_MS)) return null;
  return codeNormalisieren(code);
}
