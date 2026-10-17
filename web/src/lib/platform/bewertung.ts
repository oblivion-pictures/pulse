import { huelleKennt } from './huelleKann';
import { isCapacitorIOS } from './runtime';
import { alsGefragtWerten, frageMoment, sollFragen } from './bewertungRegel';
import { sendungZaehlen } from './eigeneSendungen';

/**
 * Die System-Bewertungsfrage, gestellt im richtigen Moment.
 *
 * Nur in der iOS-Hülle — die Frage ist eine App-Store-Sache. Der Zählstand
 * liegt im `localStorage` dieses Geräts; er muss weder genau noch
 * geräteübergreifend sein: er soll nur verhindern, dass ein frischer Nutzer
 * gefragt wird (Begründung in `bewertungRegel.ts`).
 *
 * **Der Zähler selbst liegt seit 2026-10-08 nebenan** (`eigeneSendungen.ts`),
 * weil die Vorerklärung zu Mitteilungen dieselbe Zahl braucht. Im eigenen
 * Schlüssel steht seither NUR `bereitsGefragt` — das ist die einzige
 * Eigenschaft, die zu DIESER Frage gehört; die Zahl daneben mitzuschreiben
 * wäre eine zweite Kopie, die niemand mehr liest. Folge beim Update: ein
 * vorhandener Zählstand im alten Schlüssel wird nicht übernommen, die
 * Bewertungsfrage kommt also einmalig später. Bewusst kein Umzug für eine
 * Zahl, deren Verlust nur die harmlose Richtung kennt.
 *
 * **Die Antwort des Nutzers ist nicht auslesbar.** `requestReview` sagt nie,
 * ob die Frage erschienen ist oder was der Nutzer getan hat. Deshalb wird
 * „bereits gefragt" gesetzt, sobald wir es VERSUCHT haben — die Alternative
 * wäre, es unbegrenzt zu wiederholen. **Ausnahme (Review B13):** meldet die
 * Hülle ausdrücklich `angezeigt: false` (keine aktive Szene), war es kein
 * Versuch, und die Frage bleibt für die nächste Nachricht offen. Ältere Bauten
 * ohne das Feld zählen wie bisher.
 *
 * **Nicht bei offener Tastatur:** die Frage kommt erst, wenn kein Eingabefeld
 * mehr den Fokus hat (`frageMoment`), sonst legt sie sich direkt nach dem
 * Senden mitten in die Unterhaltung.
 */

interface ReviewPlugin {
  /** Neuere Bauten melden, ob die Frage wirklich gestellt wurde; ältere
   *  antworten ohne Wert (`alsGefragtWerten`). */
  anfragen(): Promise<{ angezeigt?: boolean } | void>;
}

const SCHLUESSEL = 'pulse.bewertung';

/** Wartet gerade eine Frage auf einen ruhigen Moment? Gegen eine zweite daneben. */
let wartet = false;

function plugin(): ReviewPlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (cap?.Plugins?.ReviewPlugin as ReviewPlugin | undefined) ?? null;
}

function bereitsGefragt(): boolean {
  try {
    const roh = window.localStorage.getItem(SCHLUESSEL);
    if (roh) return (JSON.parse(roh) as { bereitsGefragt?: unknown }).bereitsGefragt === true;
  } catch {
    // Kein oder kaputter Speicher — dann gilt „noch nicht gefragt". Der
    // Schaden wäre eine zweite Frage, nicht eine verlorene.
  }
  return false;
}

function merkeGefragt(): void {
  try {
    window.localStorage.setItem(SCHLUESSEL, JSON.stringify({ bereitsGefragt: true }));
  } catch {
    /* Speicher voll oder abgeschaltet — dann eben nicht. */
  }
}

/**
 * Eine erfolgreich gesendete Nachricht melden. Fragt, sobald die Regel es
 * zulässt. No-op ausserhalb der iOS-Hülle — dort gibt es nichts zu fragen,
 * und der Zähler soll gar nicht erst mitlaufen.
 */
export function sendungGezaehlt(): void {
  // Der Zähler läuft IMMER mit, auch ausserhalb der iOS-Hülle: die
  // Vorerklärung zu Mitteilungen liest ihn ebenfalls, und sie gilt auch für
  // Android. Die Bewertungsfrage selbst bleibt iOS-eigen.
  const gesendet = sendungZaehlen();
  if (!isCapacitorIOS()) return;
  // Erst fragen, ob der Bau fragen KANN — sonst verbrauchte ein älterer Bau
  // ohne Plugin die einzige Frage (F8, s. `bewertungRegel.ts`).
  const pluginDa = huelleKennt('ReviewPlugin', 'anfragen');
  if (!sollFragen({ gesendet, bereitsGefragt: bereitsGefragt(), pluginDa })) return;
  if (!wartet) fragenSobaldRuhig();
}

/** Ein Eingabefeld mit Fokus heisst auf dem Telefon: die Tastatur steht. */
function tastaturOffen(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable;
}

function fragenSobaldRuhig(): void {
  wartet = true;
  const start = Date.now();
  const takt = setInterval(() => {
    const moment = frageMoment({ tastaturOffen: tastaturOffen(), seitSendenMs: Date.now() - start });
    if (moment === 'warten') return;
    clearInterval(takt);
    if (moment === 'verwerfen') {
      wartet = false;
      return;
    }
    void jetztFragen();
  }, 500);
}

async function jetztFragen(): Promise<void> {
  try {
    // Eine Ablehnung des Aufrufs gilt wie bisher als Versuch: er soll bei der
    // nächsten Nachricht nicht wieder kommen.
    const antwort = await plugin()?.anfragen().catch(() => undefined);
    if (alsGefragtWerten(antwort)) merkeGefragt();
  } finally {
    wartet = false;
  }
}
