/**
 * Ton- und Session-Diagnose der iOS-App — was rund um ein ausgefallenes
 * Mikrofon geschah, im Ringpuffer des Käfer-Knopfs (`app-diagnose.ts`), und bei
 * einem echten Anlass EIN kompakter Bericht an den Diagnose-Endpunkt.
 *
 * **Warum es das gibt** (TestFlight 2.1): das Mikrofon im nativen Sprachkanal
 * fiel aus und erholte sich nur durch einen App-Neustart, und nichts auf dem
 * Gerät hielt fest, warum. Drei Ketten kamen in Frage (Befundakte vom
 * 2026-10-17: WebKit nimmt die Session, die Buchführung des SDK hängt, ein
 * Anruf-Merker bleibt stehen); sie unterscheiden sich nur an Zuständen, die
 * die Hülle und WebKit kennen — die stehen jetzt hier.
 *
 * **Automatisch gesendet wird nur bei einem Anlass** (Eigentümer-Entscheid
 * 2026-10-17): der Wächter musste eingreifen, das Mikrofon ist tot, eine
 * Unterbrechung endet nicht, die Mediendienste starteten neu, eine Aktivierung
 * scheiterte, ein Anruf-Zustand hing. Nie periodisch, nie beim normalen
 * Beitreten. Je Anlass EIN Bericht (was in den folgenden 30 s dazukommt, hängt
 * sich an), höchstens einer je 10 min und fünf je Tag — gezählt wird jeder
 * VERSUCH, auch ein gescheiterter, sonst wäre die Drossel bei fehlendem Netz
 * keine (Gegenprüfung T4). **Die `bild_*`-Anlässe haben ein eigenes Budget**
 * (Review B11): ein hängender Bildstart darf nicht den einen Bericht je
 * 10 min aufbrauchen, den ein echtes `mikro_tot` braucht. **Ein Anlass
 * überlebt das App-Ende:** der 30-s-Sammler feuert nicht, wenn iOS die App
 * vorher einfriert oder beendet — der Anlass steht deshalb im `localStorage`
 * und wird beim nächsten Start nachgereicht (nur Anlass-Namen aus der Liste
 * unten, keine Inhalte). Höchstens 60 KiB; Opt-out wie am Desktop
 * (`uploadDiagnosticLogs`, Schalter in den Ton-Einstellungen der App).
 *
 * **Inhalt:** nur Zeilen dieses Bausteins (`ios_ton`) aus den zwei Minuten vor
 * dem Anlass bis zum Versand — Zustände, Zähler, Gründe. Keine Kanal- oder
 * Nutzer-IDs, keine Namen, keine Tokens, keine Chat-Inhalte: die Hülle meldet
 * solche Felder nicht (`SpracheRaumNeustart.swift::diagnoseFelder`), und die
 * Web-Zeilen tragen nur Typen und Zählerstände.
 *
 * Importe mit `.ts`-Endung und ohne Stores, damit Nodes Läufer die Regeln
 * prüfen kann (CLAUDE.md, `pnpm test:unit`). Den Versand reicht die App
 * hinein (`berichtSenderSetzen`, `iosTonBerichtSenden.ts`).
 */

import { leseRingpuffer, melde } from './app-diagnose.ts';
import { isIosWebKit } from '../platform/runtime.ts';

export const IOS_TON_BAUSTEIN = 'ios_ton';

type Werte = Record<string, string | number | boolean>;

/** Arten, die einen Bericht auslösen. Alles andere ist nur Verlauf. */
export const ANLAESSE: ReadonlySet<string> = new Set([
  'wache_stufe',
  'mikro_tot',
  'unterbrechung_haengt',
  'media_reset',
  'maschine_neu_fehler',
  'spur_neu_fehler',
  'beitritt_ohne_mikro',
  'callkit_haengt',
  'anruf_pause_haengt',
  // HQ-Kachel mit nativem Ton ohne Bild (`hqStreamManager.svelte.ts`,
  // `stream/bildStart.ts`) — der einzige Weg, auf dem ein Bildstart der
  // iOS-Hülle den Server erreicht.
  'bild_gesperrt',
  'bild_haengt',
  'bild_fehler',
  // Bild stand fremd pausiert (`stream/bildWache.ts`) — Unterbrechung durch
  // WebKit oder nach dem Ende einer Unterbrechung des nativen Tons.
  'bild_pausiert_von_webkit',
  'bild_pausiert_nach_nativ_ton'
]);

export const SAMMEL_MS = 30_000;
export const VORLAUF_MS = 120_000;
export const ABSTAND_MS = 10 * 60_000;
export const JE_TAG = 5;
const TAG_MS = 24 * 60 * 60_000;
/** Unter der 64-KiB-Grenze für `fetch(…, {keepalive})` (WHATWG Fetch). */
export const BERICHT_MAX_BYTES = 60 * 1024;
/** Ein nachgereichter Anlass, der älter ist, erzählt nichts Brauchbares mehr. */
export const OFFEN_MAX_ALTER_MS = TAG_MS;
const LADE_KEY = 'pulse.diag.ladezaehler';

/**
 * Darf zu einem Anlass ein Bericht entstehen? `offen`: einer sammelt gerade —
 * dann hängt sich der Anlass an, statt einen zweiten zu beginnen.
 */
export function berichtEntscheiden(
  gesendet: readonly number[],
  jetzt: number,
  offen: boolean
): 'neu' | 'anhaengen' | 'gedrosselt' {
  if (offen) return 'anhaengen';
  // Eine zurückgesprungene Uhr (Zeitstempel in der Zukunft) sperrt nicht.
  const gueltig = gesendet.filter((t) => t <= jetzt);
  const zuletzt = Math.max(0, ...gueltig);
  if (zuletzt && jetzt - zuletzt < ABSTAND_MS) return 'gedrosselt';
  if (gueltig.filter((t) => jetzt - t < TAG_MS).length >= JE_TAG) return 'gedrosselt';
  return 'neu';
}

/** Zwei getrennte Budgets: `bild_*` (Bildstart der HQ-Kachel) und alles andere. */
export type Gruppe = 'ton' | 'bild';

export function gruppeVon(art: string): Gruppe {
  return art.startsWith('bild_') ? 'bild' : 'ton';
}

export interface OffenerBericht {
  start: number;
  anlaesse: string[];
}

/**
 * Den gemerkten, nie abgeschickten Bericht wieder lesen. `null`, wenn nichts
 * da ist, es nicht lesbar ist oder zu alt. Übernommen werden nur Anlass-Namen
 * aus {@link ANLAESSE} — was sonst im Speicher steht, gelangt nie in einen
 * Bericht.
 */
export function offenenBerichtLesen(roh: string | null, jetzt: number): OffenerBericht | null {
  if (!roh) return null;
  try {
    const o = JSON.parse(roh) as { start?: unknown; anlaesse?: unknown };
    if (typeof o.start !== 'number' || o.start > jetzt || jetzt - o.start > OFFEN_MAX_ALTER_MS)
      return null;
    const anlaesse = Array.isArray(o.anlaesse)
      ? o.anlaesse.filter((a): a is string => typeof a === 'string' && ANLAESSE.has(a)).slice(0, 16)
      : [];
    return anlaesse.length ? { start: o.start, anlaesse } : null;
  } catch {
    return null;
  }
}

/** Die Zeilen fürs Senden: dieser Baustein, ab `start - VORLAUF_MS`. */
export function berichtZeilen(
  ereignisse: readonly { ts: number; baustein: string; kategorie: string; anzahl: number; kontext?: Werte }[],
  start: number
): { s: number; art: string; anzahl: number; werte?: Werte }[] {
  const ab = start - VORLAUF_MS;
  const eigene = ereignisse.filter((e) => e.baustein === IOS_TON_BAUSTEIN && e.ts >= ab);
  const basis = eigene[0]?.ts ?? start;
  return eigene.slice(-250).map((e) => ({
    s: Math.max(0, Math.round((e.ts - basis) / 100) / 10),
    art: e.kategorie.slice(0, 48),
    anzahl: e.anzahl,
    ...(e.kontext ? { werte: e.kontext } : {})
  }));
}

/**
 * Den Bericht auf `max` Bytes kappen — die ÄLTESTEN Zeilen gehen zuerst, der
 * Anlass steht am Ende. `koerper` baut den ganzen Versandtext aus den
 * verbliebenen Zeilen und der Zahl der verworfenen.
 */
export function berichtKappen<T>(
  zeilen: readonly T[],
  koerper: (rest: T[], verworfen: number) => string,
  max = BERICHT_MAX_BYTES
): string {
  const laenge = (t: string) => new TextEncoder().encode(t).length;
  let rest = [...zeilen];
  let text = koerper(rest, 0);
  while (laenge(text) > max && rest.length > 0) {
    // Grob vorspringen statt je Zeile neu zu serialisieren.
    const weg = Math.max(1, Math.ceil(rest.length * (1 - max / laenge(text))));
    rest = rest.slice(weg);
    text = koerper(rest, zeilen.length - rest.length);
  }
  return text;
}

// --- Zustand der laufenden Seite -----------------------------------------

export type BerichtSender = (bericht: {
  anlaesse: string[];
  zeilen: ReturnType<typeof berichtZeilen>;
}) => Promise<boolean>;

let sender: BerichtSender | null = null;
const offen: Record<Gruppe, { start: number; anlaesse: Set<string> } | null> = {
  ton: null,
  bild: null
};
let ladeNummer: number | null = null;

/** Speicherschlüssel je Gruppe: gesendete Versuche (Drossel) und offener Bericht. */
const GESENDET: Record<Gruppe, string> = {
  ton: 'pulse.diag.ios_ton_berichte',
  bild: 'pulse.diag.ios_ton_berichte_bild'
};
const OFFEN: Record<Gruppe, string> = {
  ton: 'pulse.diag.ios_ton_offen',
  bild: 'pulse.diag.ios_ton_offen_bild'
};
const GRUPPEN: readonly Gruppe[] = ['ton', 'bild'];

/** Die App reicht den Versand hinein (nur iOS, `iosTonBerichtSenden.ts`). Mit
 *  einem Sender werden Anlässe der letzten Sitzung nachgereicht. */
export function berichtSenderSetzen(s: BerichtSender | null): void {
  sender = s;
  if (s) offenesNachreichen(Date.now());
}

function speicher(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function gesendetLesen(gruppe: Gruppe): number[] {
  try {
    const roh = JSON.parse(speicher()?.getItem(GESENDET[gruppe]) ?? '[]') as unknown;
    return Array.isArray(roh) ? roh.filter((t): t is number => typeof t === 'number') : [];
  } catch {
    return [];
  }
}

function gesendetMerken(gruppe: Gruppe, jetzt: number): void {
  try {
    const rest = gesendetLesen(gruppe).filter((t) => t <= jetzt && jetzt - t < TAG_MS);
    speicher()?.setItem(GESENDET[gruppe], JSON.stringify([...rest, jetzt]));
  } catch {
    /* best effort */
  }
}

/** Den offenen Bericht im Speicher festhalten (oder streichen) — für den Fall,
 *  dass der Sammel-Zeitgeber durch App-Ende oder Einfrieren nie feuert. */
function offenMerken(gruppe: Gruppe): void {
  try {
    const b = offen[gruppe];
    if (b) {
      const wert: OffenerBericht = { start: b.start, anlaesse: [...b.anlaesse] };
      speicher()?.setItem(OFFEN[gruppe], JSON.stringify(wert));
    } else {
      speicher()?.removeItem(OFFEN[gruppe]);
    }
  } catch {
    /* best effort */
  }
}

/** Beim Start: was die letzte Sitzung als Anlass hinterliess und nie abschickte,
 *  jetzt senden — nach derselben Drossel wie ein frischer Anlass. */
function offenesNachreichen(jetzt: number): void {
  for (const gruppe of GRUPPEN) {
    if (offen[gruppe]) continue; // diese Sitzung sammelt schon
    let roh: string | null = null;
    try {
      roh = speicher()?.getItem(OFFEN[gruppe]) ?? null;
    } catch {
      /* kein Speicher */
    }
    if (roh === null) continue;
    const alt = offenenBerichtLesen(roh, jetzt);
    if (!alt || berichtEntscheiden(gesendetLesen(gruppe), jetzt, false) !== 'neu') {
      offenMerken(gruppe); // `offen` ist leer -> streicht den Eintrag
      continue;
    }
    offen[gruppe] = { start: alt.start, anlaesse: new Set([...alt.anlaesse, 'nachgereicht']) };
    void abschicken(gruppe);
  }
}

/** Wie oft dieses Dokument in dieser App-Sitzung geladen wurde — ein Sprung
 *  heisst: WebKit hat den Inhaltsprozess neu gestartet (Verdacht in K1). */
function ladeZaehler(): number {
  if (ladeNummer !== null) return ladeNummer;
  try {
    const s = typeof sessionStorage === 'undefined' ? null : sessionStorage;
    ladeNummer = Number(s?.getItem(LADE_KEY) ?? 0) + 1;
    s?.setItem(LADE_KEY, String(ladeNummer));
  } catch {
    ladeNummer = 0;
  }
  return ladeNummer;
}

/** WebKits eigene Erklärung (`navigator.audioSession`, ab iOS 17). */
export function webkitSession(): Werte {
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as {
    audioSession?: { type?: string; state?: string };
  };
  return {
    webkit_typ: nav.audioSession?.type ?? 'fehlt',
    webkit_zustand: nav.audioSession?.state ?? 'fehlt'
  };
}

/**
 * Eine Zeile in den Ring — nur auf iOS-WebKit. Ist `art` ein Anlass, beginnt
 * (oder ergänzt) sie einen Bericht.
 */
export function iosTonMelden(art: string, werte: Werte = {}): void {
  if (!isIosWebKit()) return;
  melde(IOS_TON_BAUSTEIN, art, art, { ...webkitSession(), laden: ladeZaehler(), ...werte });
  if (ANLAESSE.has(art)) anlass(art, Date.now());
}

/** Ein Hinweiston auf dem iOS-Weg (`sounds/engine.ts`). */
export function iosTonGespielt(ton: string): void {
  iosTonMelden('ton', { ton });
}

function anlass(art: string, jetzt: number): void {
  if (!sender) return;
  const gruppe = gruppeVon(art);
  const b = offen[gruppe];
  const entscheid = berichtEntscheiden(gesendetLesen(gruppe), jetzt, b !== null);
  if (entscheid === 'gedrosselt') return;
  if (entscheid === 'anhaengen' && b) {
    b.anlaesse.add(art);
    offenMerken(gruppe);
    return;
  }
  offen[gruppe] = { start: jetzt, anlaesse: new Set([art]) };
  offenMerken(gruppe);
  setTimeout(() => void abschicken(gruppe), SAMMEL_MS);
}

async function abschicken(gruppe: Gruppe): Promise<void> {
  const b = offen[gruppe];
  offen[gruppe] = null;
  const s = sender;
  if (!b || !s) return;
  const zeilen = berichtZeilen(leseRingpuffer(), b.start);
  // Gezählt und aus dem Speicher gestrichen, BEVOR gesendet wird: ein Absturz
  // mitten im Versand soll keine Dauerschleife aus Nachreichen ergeben.
  gesendetMerken(gruppe, Date.now());
  offenMerken(gruppe);
  try {
    await s({ anlaesse: [...b.anlaesse], zeilen });
  } catch {
    /* Diagnose darf nie stören. */
  }
}
