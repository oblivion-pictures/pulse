import { isCapacitorIOS } from './runtime';
import {
  iosJetztLaeuft,
  iosJetztLaeuftAus,
  iosPlaybackModus,
  iosSessionAus
} from './iosAudioSession';
import { NACH_NATIVEM_RAUM, tonSchritt, zielModus, type TonModus } from './tonModus';

/**
 * Der eine Ort, der die iOS-Audio-Session für WEBVIEW-WIEDERGABE schaltet
 * (Stream-Kachel, Watch-Party).
 *
 * Sprachkanal und Anrufe laufen in der iOS-Hülle nativ und halten ihre Session
 * selbst; den Web-Weg dafür gibt es dort nicht mehr (Eigentümer-Entscheide
 * E6, 2026-10-18). Hier bleibt, was der Ton der WebView braucht. Die
 * Entscheidung, welche Betriebsart gerade stimmt, steht in `tonModus.ts`
 * (geprüft) und wird hier angewandt.
 *
 * **Wiedergaben werden als MENGE geführt, nicht als Zähler.** Ein
 * Stream-Manager meldet seinen Ton beim Anhängen des Stroms an — und das
 * passiert bei einem Wiederaufbau erneut für denselben Strom. Ein Zähler
 * liefe davon nach oben weg und die Session bliebe nach dem letzten Stream
 * für immer aktiv; eine Menge ist von sich aus idempotent.
 *
 * `aus` deaktiviert die Session (`notifyOthersOnDeactivation`).
 *
 * **Eine Ausnahme: der native Sprachraum.** Solange die Hülle ihn hält,
 * gehört die Session LiveKit, und hier wird nichts angefasst
 * (`tonNativerRaum`).
 *
 * Browser, Electron und Android: No-op (`isCapacitorIOS`-Gate in der
 * Plugin-Schicht; Android hat mit `audioRoute.ts` sein eigenes Gegenstück).
 */

const wiedergaben = new Set<string>();
let angewandt: TonModus = 'aus';

/** Steht ein nativer Sprachraum? S. `tonNativerRaum`. */
let nativerRaum = false;

/**
 * Hält die Hülle gerade einen nativen Sprachraum? Dann gehört die Session
 * LiveKit, und hier wird sie NICHT angefasst — weder umgestellt noch
 * deaktiviert (Begründung an `tonSchritt` in `tonModus.ts`). Gesetzt allein
 * aus `platform/iosSprache.ts`, zusammen mit WebKits `ambient`.
 *
 * **Sofort gesetzt, nicht in der Kette:** ein schon wartender Schritt soll
 * beim Anlaufen sehen, dass der Raum steht. Das Zurücksetzen von `angewandt`
 * beim Ende läuft dagegen IN der Kette — ein Schritt, der gerade noch
 * arbeitet, würde es sonst überschreiben.
 */
export function tonNativerRaum(an: boolean): void {
  if (nativerRaum === an) return;
  nativerRaum = an;
  if (an) return;
  kette = kette.then(() => {
    angewandt = NACH_NATIVEM_RAUM;
  });
  void anwenden();
}

/**
 * **Die Schritte laufen der Reihe nach.** Bis zum 2026-10-11 setzte jeder
 * Aufruf `angewandt` VOR dem `await` — damit zwei schnelle Aufrufe nicht
 * doppelt einrichteten. Der Preis: scheiterte die Hülle, galt die Betriebsart
 * trotzdem als angewandt und wurde nie wieder versucht (Bughunt G2). Jetzt
 * wird erst NACH dem Gelingen gemerkt, und die Kette sorgt dafür, dass kein
 * zweiter Schritt über einen laufenden hinwegliest.
 */
let kette: Promise<void> = Promise.resolve();

function anwenden(): Promise<void> {
  const lauf = kette.then(schritt);
  kette = lauf.catch(() => undefined);
  return lauf;
}

async function schritt(): Promise<void> {
  const ziel = zielModus(wiedergaben.size);
  if (!isCapacitorIOS()) return;
  if (tonSchritt({ ziel, angewandt, nativerRaum }) === 'nichts') return;
  // Gescheitert: NICHT merken. Der nächste Anlass versucht es erneut — ein
  // eigener Wiederholungs-Takt wäre genau die Rückkopplung, die diese Datei
  // am 2026-10-10 an der Wurzel beseitigt hat.
  if (!(await einrichten(ziel))) return;
  angewandt = ziel;
}

/** Die Hülle für `ziel` einrichten lassen. `false`, wenn sie scheitert. */
async function einrichten(ziel: TonModus): Promise<boolean> {
  // Die Wiedergabe-Kategorie richtet sich nicht nach dem Ausgabeweg.
  return ziel === 'wiedergabe' ? iosPlaybackModus() : iosSessionAus();
}

/**
 * Ton einer Wiedergabe an- oder abmelden. `kennung` identifiziert die Quelle
 * (Stream-Kachel, Watch-Party) — mehrfaches Anmelden derselben Kennung zählt
 * einmal, s. Modulkopf.
 */
export function tonWiedergabe(kennung: string, an: boolean, titel?: string): void {
  const vorher = wiedergaben.size;
  if (an) wiedergaben.add(kennung);
  else wiedergaben.delete(kennung);
  if ((vorher > 0) !== (wiedergaben.size > 0)) {
    for (const h of [...wiedergabeHoerer]) h(wiedergaben.size > 0);
  }
  void anwenden();
  // Sperrbildschirm-Anzeige hängt an der ERSTEN und der LETZTEN Wiedergabe,
  // nicht an jeder: bei zwei offenen Kacheln soll die zweite die Anzeige der
  // ersten nicht überschreiben und ihr Schliessen sie nicht abräumen.
  if (an && vorher === 0) {
    void iosJetztLaeuft(titel || 'Pulse', titel ? 'Pulse' : '');
  } else if (!an && wiedergaben.size === 0) {
    void iosJetztLaeuftAus();
  }
}

const wiedergabeHoerer = new Set<(laeuft: boolean) => void>();

/**
 * Spielt die WebView selbst gerade Ton ab (eine Kachel auf dem WebView-Weg,
 * eine Watch-Party)? Für den nativen Stream-Ton (`stream/streamTonLage.ts`):
 * ausserhalb eines Raums vertragen sich beide nicht. Native Kacheln melden
 * sich hier nicht an. Rückgabe meldet ab.
 */
export function tonWiedergabenBeobachten(h: (laeuft: boolean) => void): () => void {
  wiedergabeHoerer.add(h);
  h(wiedergaben.size > 0);
  return () => wiedergabeHoerer.delete(h);
}
