/**
 * Wann die System-Bewertungsfrage gestellt werden darf.
 *
 * **Warum eine Regel und nicht einfach „nach dem Senden":** iOS zeigt die
 * Frage höchstens dreimal im Jahr je Nutzer und sagt nie, ob sie erschienen
 * ist. Jeder Aufruf verbraucht also ein knappes Kontingent, blind. Wer bei
 * jedem Senden fragt, verschiesst es in der ersten Minute — und zwar genau
 * dann, wenn der Nutzer die App noch gar nicht kennt und am ehesten schlecht
 * bewertet.
 *
 * Deshalb: erst nach einer Weile echter Nutzung, und danach nie wieder von
 * selbst. Die Zahl ist bewusst nüchtern gewählt — wer zwanzig Nachrichten
 * geschrieben hat, benutzt Pulse, statt es anzusehen.
 *
 * Importfrei, damit Nodes Testläufer die Regel prüfen kann (s. CLAUDE.md).
 */

export const SENDUNGEN_BIS_ZUR_FRAGE = 20;

export interface Bewertungsstand {
  /** Erfolgreich gesendete Nachrichten, über alle Sitzungen gezählt. */
  gesendet: number;
  /** Wurde schon einmal gefragt? */
  bereitsGefragt: boolean;
  /** Kann der installierte Bau überhaupt fragen (`ReviewPlugin.anfragen`)?
   *  Fehlt die Angabe, gilt ja — so riefen es die Aufrufer vor F8. */
  pluginDa?: boolean;
}

/**
 * **Ohne Plugin wird nicht gefragt — und das zählt nicht als gefragt**
 * (iOS-Bughunt 2, F8). Bis zum 2026-10-11 merkte sich die Web-App „gefragt",
 * bevor sie wusste, ob die Hülle die Frage stellen kann. Ein älterer Bau ohne
 * `ReviewPlugin` verbrauchte die einzige Frage damit wortlos, und nach dem
 * Update kam sie nie.
 */
export function sollFragen(stand: Bewertungsstand): boolean {
  if (stand.bereitsGefragt || stand.pluginDa === false) return false;
  return stand.gesendet >= SENDUNGEN_BIS_ZUR_FRAGE;
}

/** So lange mindestens wartet die Frage nach dem Senden (die Sendebewegung ist
 *  dann vorbei, der Nutzer liest, was er geschrieben hat). */
export const FRAGE_MINDESTWARTEN_MS = 1500;
/** Länger als das wartet sie nicht auf eine geschlossene Tastatur: wer minutenlang
 *  tippt, hat gerade keinen Moment für eine Frage — dann beim nächsten Senden. */
export const FRAGE_WARTEN_MAX_MS = 5 * 60_000;

/**
 * Ist jetzt der Moment für die System-Frage? Direkt nach dem Senden steht die
 * Tastatur meist noch offen; die Frage legte sich darüber, mitten in die
 * Unterhaltung (iOS-Review B13). Deshalb: erst nach kurzer Pause UND bei
 * geschlossener Tastatur; nach {@link FRAGE_WARTEN_MAX_MS} verfällt der Versuch
 * (nicht als gefragt gezählt — er kommt mit der nächsten Nachricht wieder).
 */
export function frageMoment(o: {
  tastaturOffen: boolean;
  seitSendenMs: number;
}): 'warten' | 'fragen' | 'verwerfen' {
  if (o.seitSendenMs > FRAGE_WARTEN_MAX_MS) return 'verwerfen';
  if (o.seitSendenMs < FRAGE_MINDESTWARTEN_MS || o.tastaturOffen) return 'warten';
  return 'fragen';
}

/**
 * Hat die Hülle die Frage wirklich gestellt? Neuere Bauten melden
 * `{ angezeigt }` (keine aktive Szene: `false`); ein älterer Bau antwortet
 * ohne das Feld, und dann gilt wie bisher: gefragt. Nur ein ausdrückliches
 * `false` hält die Frage offen.
 */
export function alsGefragtWerten(antwort: unknown): boolean {
  return (antwort as { angezeigt?: unknown } | null | undefined)?.angezeigt !== false;
}
