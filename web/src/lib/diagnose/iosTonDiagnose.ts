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
 * keine (Gegenprüfung T4). Höchstens 60 KiB; Opt-out wie am Desktop
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
  // „Volle Tonqualität" nach einem Anruf nicht zurückgestellt (`SpracheRaumNeustart.swift`).
  'volle_ton_zurueck_fehler',
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
/** Unter der 64-KiB-Grenze für `fetch(…, {keepalive})` (WHATWG Fetch). */
export const BERICHT_MAX_BYTES = 60 * 1024;
const TAG_MS = 24 * 60 * 60_000;
const GESENDET_KEY = 'pulse.diag.ios_ton_berichte';
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
let offen: { start: number; anlaesse: Set<string> } | null = null;
let ladeNummer: number | null = null;

/** Die App reicht den Versand hinein (nur iOS, `iosTonBerichtSenden.ts`). */
export function berichtSenderSetzen(s: BerichtSender | null): void {
  sender = s;
}

function speicher(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function gesendetLesen(): number[] {
  try {
    const roh = JSON.parse(speicher()?.getItem(GESENDET_KEY) ?? '[]') as unknown;
    return Array.isArray(roh) ? roh.filter((t): t is number => typeof t === 'number') : [];
  } catch {
    return [];
  }
}

function gesendetMerken(jetzt: number): void {
  try {
    const rest = gesendetLesen().filter((t) => t <= jetzt && jetzt - t < TAG_MS);
    speicher()?.setItem(GESENDET_KEY, JSON.stringify([...rest, jetzt]));
  } catch {
    /* best effort */
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
  const entscheid = berichtEntscheiden(gesendetLesen(), jetzt, offen !== null);
  if (entscheid === 'gedrosselt') return;
  if (entscheid === 'anhaengen' && offen) {
    offen.anlaesse.add(art);
    return;
  }
  offen = { start: jetzt, anlaesse: new Set([art]) };
  setTimeout(() => void abschicken(), SAMMEL_MS);
}

async function abschicken(): Promise<void> {
  const b = offen;
  offen = null;
  const s = sender;
  if (!b || !s) return;
  const zeilen = berichtZeilen(leseRingpuffer(), b.start);
  gesendetMerken(Date.now());
  try {
    await s({ anlaesse: [...b.anlaesse], zeilen });
  } catch {
    /* Diagnose darf nie stören. */
  }
}
