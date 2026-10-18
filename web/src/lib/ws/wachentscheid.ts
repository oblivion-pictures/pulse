/**
 * „Was tun, wenn das Gerät aufwacht oder das Netz wechselt?" — die reine
 * Rechnung dahinter.
 *
 * **Warum es diese Entscheidung überhaupt gibt.** Der Reconnect staffelt sich
 * bewusst bis 300 s auseinander (`RECONNECT_BACKOFF_MS`), und das ist richtig
 * gegen einen Server, der uns aktiv abweist. Für ein Telefon ist es die
 * falsche Zahl: wer durch einen Tunnel fährt, das Flugzeug-Symbol an- und
 * ausschaltet oder von WLAN auf Mobilfunk wechselt, steht danach bis zu fünf
 * Minuten vor einer stillstehenden App. Es fehlt nicht ein kürzerer Takt,
 * sondern ein ANLASS: Netz ist wieder da, App ist wieder vorn.
 *
 * **Ein offener Socket beweist dabei nichts.** Nach einem Netzwechsel bleibt
 * er oft `OPEN` und ist tot — der Browser erfährt vom abgerissenen TCP nichts.
 * Der Herzschlag merkt das, aber erst nach `WS_PONG_TIMEOUT_MS` (90 s,
 * absichtlich gross, weil Browser `setInterval` im Hintergrund drosseln). Beim
 * Aufwachen ist eine kurze Frist angebracht, und nur dort.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 * Die `readyState`-Zahlen stehen hier als Zahlen, weil `WebSocket` in Nodes
 * Testläufer nichts zu suchen hat; sie sind in der WHATWG-Norm festgelegt und
 * können sich nicht ändern.
 */

/** `WebSocket.CONNECTING` */
export const VERBINDET = 0;
/** `WebSocket.OPEN` */
export const OFFEN = 1;
/** `WebSocket.CLOSING` */
export const SCHLIESST = 2;
/** `WebSocket.CLOSED` */
export const GESCHLOSSEN = 3;

/** Kürzester Abstand zwischen zwei Weckprüfungen. „Netz wieder da",
 *  „Tab wieder sichtbar" und „App wieder vorn" feuern beim Entsperren eines
 *  Telefons gern gemeinsam — ohne diesen Abstand liefen drei Prüfungen
 *  gleichzeitig. */
export const MINDESTABSTAND_MS = 1000;

export type Wachbefund =
  /** Nichts tun: unerwünscht, abgewiesen, zu früh, oder ein Versuch läuft
   *  schon. */
  | 'nichts'
  /** Es gibt keinen brauchbaren Socket — jetzt verbinden, ohne auf die
   *  nächste Backoff-Stufe zu warten. */
  | 'sofort-verbinden'
  /** Socket ist offen, aber womöglich tot — Ping mit kurzer Frist. */
  | 'ping-pruefen';

/**
 * Zustände, in denen der Server uns AKTIV abgewiesen hat: zu alt (4044), im
 * Update (4045), gesperrt (4070). Dort zählt die Staffelung bis 300 s, und
 * ein Weckanlass darf sie nicht überspringen — sonst klopfte jedes
 * Entsperren, jeder Tab-Wechsel und jeder Netzwechsel sofort wieder an
 * (Bughunt Runde 43, s. `gateway-connection.ts::wachPruefen`). Die
 * Oberfläche zeigt für sie ohnehin ihre eigene Anzeige
 * (`offlinehinweis.ts::EIGENE_ANZEIGE`).
 */
export const ABWEISENDE_ZUSTAENDE: readonly string[] = ['incompatible', 'updating', 'suspended'];

export interface Wachlage {
  /** Will der Klient überhaupt verbunden sein? Nach einem Abmelden nicht. */
  gewuenscht: boolean;
  /** `ConnectionState` der Verbindung (`gateway-connection.ts`). */
  zustand: string;
  /** `readyState` des Sockets, oder `null` wenn gar keiner da ist. */
  bereit: number | null;
  /** Läuft bereits eine Ping-Prüfung mit Frist? */
  pruefungLaeuft: boolean;
  /** Abstand zur letzten Weckprüfung. */
  seitLetzterPruefungMs: number;
}

export function wachEntscheid(lage: Wachlage): Wachbefund {
  if (!lage.gewuenscht) return 'nichts';
  if (ABWEISENDE_ZUSTAENDE.includes(lage.zustand)) return 'nichts';
  if (lage.seitLetzterPruefungMs < MINDESTABSTAND_MS) return 'nichts';
  // Kein Socket, oder einer im Abbau: der Abbau endet in `close` und damit im
  // gestaffelten Reconnect — darauf warten wir nicht. Die Verbindung hängt
  // den alten Socket dafür ab, und sein spätes `close` fasst den neuen nicht
  // mehr an (`gateway-connection.ts::_abhaengen`).
  if (lage.bereit === null || lage.bereit === SCHLIESST || lage.bereit === GESCHLOSSEN) {
    return 'sofort-verbinden';
  }
  // Ein Aufbau läuft schon; ein zweiter daneben brächte nichts.
  if (lage.bereit === VERBINDET) return 'nichts';
  // Bleibt `OFFEN`: ein zweiter Ping neben einer laufenden Frist brächte
  // nichts — der erste entscheidet.
  if (lage.pruefungLaeuft) return 'nichts';
  return 'ping-pruefen';
}

/**
 * „Soll beim Hintergrund-Werden getrennt werden?" — der Gegenpol zu
 * `wachEntscheid` (dort das Aufwachen, hier das Einschlafen).
 *
 * **Warum überhaupt trennen.** Der Server stellt DM-Push nur an Geräte OHNE
 * offene WebSocket zu. Eine Android-WebView hält ihre Verbindung im
 * Hintergrund aber am Leben — der Server hält uns für wach, das FCM-Bein
 * bleibt stumm, und die Nachricht liegt laut und unsichtbar, bis die App
 * zurückkommt. Bewusstes Schließen setzt den Server sofort in den Push-Modus
 * (sauberes TCP-FIN, kein Ping-Timeout); beim Zurückholen weckt der
 * isActive-Anlass (`netzwache.ts`) die Verbindungen wieder, und Gap-Fill
 * holt Versäumtes nach.
 *
 * Plattform: nur die Android-Hülle. Im Browser soll der Hintergrund-Tab
 * weiter leben (Desktop-Nutzer wollen live bleiben), und iOS friert seine
 * Hülle im Hintergrund ohnehin ein — dort ist der Ist-Zustand Beweis genug,
 * dass der Socket tot ist.
 *
 * `sperren` sind die Zustände, deren Signalisierung an derselben Leitung
 * hängt und die deshalb weiter verbunden bleiben: laufender Sprachkanal und
 * Anruf. Der Foreground-Service hält die App in denen ohnehin wach, und ein
 * Klingeln/Annehmen über einen toten Socket funktioniert nicht.
 */
export function hintergrundTrennung(
  huelle: boolean,
  sperren: readonly (() => boolean)[]
): boolean {
  if (!huelle) return false;
  return !sperren.some((sperre) => sperre());
}
