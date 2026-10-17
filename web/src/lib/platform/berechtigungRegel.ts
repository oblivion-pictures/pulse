/**
 * Soll vor dem System-Dialog eine Vorerklärung stehen? — die reine Regel.
 *
 * **Warum das ein eigener Punkt ist (iOS-Liste 36).** Ein System-Dialog für
 * Mitteilungen oder Kamera erscheint auf iOS **genau einmal**. Sagt
 * der Nutzer dort „nein", ist die Sache dauerhaft entschieden — der nächste
 * Versuch kommt ohne Dialog zurück, und der einzige Weg zurück führt in die
 * System-Einstellungen. Bis hierher fragte Pulse die Mitteilungs-Erlaubnis
 * **beim Start** ab, bevor der Nutzer die App überhaupt gesehen hat. Das ist
 * der ungünstigste Augenblick, den es gibt: er hat keinen Grund, ja zu sagen,
 * und sein „nein" ist endgültig.
 *
 * Die Vorerklärung kostet einen Tipp und verwandelt den Dialog in eine Frage,
 * auf die man vorbereitet ist. Sie darf aber NICHT selbst zur Plage werden,
 * deshalb vier Bedingungen:
 *
 *  1. **Nur wenn noch offen.** `granted` braucht nichts, `denied` kann nichts
 *     mehr ändern — dort wäre die Vorerklärung eine Lüge, weil der Knopf
 *     danach keinen Dialog mehr öffnet.
 *  2. **Nur in der iOS-Hülle.** Im Browser ist die Berechtigung an die Seite
 *     gebunden und jederzeit über das Schloss in der Adresszeile umkehrbar;
 *     die Einmaligkeit, gegen die wir hier arbeiten, gibt es dort nicht.
 *     **Android bleibt beim alten Weg** (Eigentümer-Entscheid 2026-10-16):
 *     Mitteilungs-Erlaubnis beim Start, kein Blatt, auch nicht vor der Kamera
 *     — s. `mitteilungenBeimStartFragen`.
 *  3. **Ein „später" hält eine Weile — bei Mitteilungen.** Wer die Erklärung
 *     dort weggetippt hat, sieht sie `SPAETER_GILT_MS` lang nicht wieder,
 *     danach beim nächsten Anlass erneut. Dazu der Weg in den Einstellungen
 *     der App (Mitteilungen). Bei der Kamera bricht „später" nur die
 *     Handlung ab (s. `ablehnungMerken`).
 *  4. **Mitteilungen brauchen einen ANLASS.** Die Kamera wird von
 *     einer Handlung ausgelöst (Kamera öffnen), die den
 *     Grund selbst erklärt. Mitteilungen nicht — deshalb hängen sie an einem
 *     Anlass, damit die Frage nicht die erste Begegnung mit der App ist: die
 *     erste eigene gesendete Nachricht, eine angenommene Freundschaftsanfrage
 *     oder die erste eingehende Direktnachricht bei offener App
 *     (`mitteilungsAnlass.ts`; Eigentümer-Entscheid 2026-10-18).
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */

/** Was gefragt werden soll. */
export type Berechtigung = 'mitteilungen' | 'kamera';
// Das Mikrofon hat keine Vorerklärung (mehr): der Sprachkanal erklärt sich
// selbst, und für die Kamera-Aufnahme wird es erst beim Wechsel auf Video
// angefragt — ein Blatt dafür hatte keinen Aufrufer.

/** Stand der Berechtigung, wie die Plattform ihn meldet. */
export type Stand = 'offen' | 'erteilt' | 'verweigert';

/**
 * Wie viele eigene Nachrichten, bevor nach Mitteilungen gefragt wird.
 *
 * Bewusst klein — seit 2026-10-18 EINE (vorher drei): schon die erste
 * Nachricht macht den Nutzen offensichtlich („ich will wissen, wenn geantwortet
 * wird"), und zu langes Warten verschenkt genau die Pushs, um die es geht.
 * Dieselbe Mechanik wie die Bewertungsfrage (`bewertungRegel.ts`), aber eine
 * viel kleinere Zahl — eine Bewertung ist eine Gefälligkeit, eine Mitteilung
 * ein Dienst am Nutzer.
 *
 * Der Name trägt deshalb die Frage mit: `bewertungRegel.ts` hat eine Schwelle
 * auf dieselbe Zahl mit anderem Wert, und zwei gleichnamige Konstanten in
 * Nachbardateien sind genau der Verwechsler, der später still importiert wird.
 */
export const SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE = 1;

export interface Lage {
  art: Berechtigung;
  stand: Stand;
  /** Läuft die App in der iOS-Hülle? Nur dort gibt es das Blatt (Punkt 2
   *  oben) — in der Android-Hülle ist das `false`. */
  iosHuelle: boolean;
  /** Hat der Nutzer die Vorerklärung für DIESE Art weggetippt, und gilt das
   *  noch (`spaeterGiltNoch`)? */
  schonAbgelehnt: boolean;
  /** Eigene gesendete Nachrichten (nur für `mitteilungen` relevant). */
  sendungen: number;
  /** Ein anderer Anlass als eine eigene Sendung liegt vor (angenommene
   *  Freundschaftsanfrage, erste eingehende Direktnachricht) — nur für
   *  `mitteilungen` relevant. */
  anlass?: boolean;
}

/**
 * Wird ein „später" gemerkt?
 *
 * **Nur für Mitteilungen.** Dort gibt es keine auslösende Handlung: „später"
 * heisst „frag mich jetzt nicht", und so wird es behandelt — für
 * `SPAETER_GILT_MS`, nicht für immer (s. `spaeterGiltNoch`).
 *
 * Bei der Kamera ist „später" dagegen **das Abbrechen der Handlung**,
 * nicht das Ablehnen der Erklärung: wer die Kamera öffnet und dann abbricht,
 * hat nichts über künftige Kamera-Öffnungen gesagt. Würde man es merken, käme
 * beim nächsten Öffnen der System-Dialog OHNE Erklärung — also genau das, was
 * dieser ganze Punkt verhindern soll, nur eine Runde später.
 */
export function ablehnungMerken(art: Berechtigung): boolean {
  return art === 'mitteilungen';
}

/**
 * So lange hält ein „später" vor der Mitteilungsfrage. **Gesetzt, nicht
 * gemessen** — wie oft man fragen darf, ohne zu nerven, ist eine Produktfrage.
 */
export const SPAETER_GILT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Gilt ein gemerktes „später" noch?
 *
 * **Warum es befristet ist** (iOS-Bughunt 2, F3). Bis zum 2026-10-11 war es
 * endgültig — und auf iOS damit die Erlaubnis: solange eine App nie gefragt
 * hat, führt iOS sie unter Einstellungen → Mitteilungen gar nicht, der
 * System-Dialog war der einzige Weg, und den öffnete nach einem „später"
 * niemand mehr (iOS-Verhalten laut Bughunt, am Gerät nicht gemessen).
 *
 * `gemerkt` ist, was im Speicher steht: seitdem der Zeitpunkt (ms), in
 * Bauten davor ein bloßes `true`. Das gilt als abgelaufen — sonst blieben
 * genau die Nutzer gesperrt, die der Fehler schon getroffen hat.
 */
export function spaeterGiltNoch(gemerkt: unknown, jetzt: number): boolean {
  return typeof gemerkt === 'number' && jetzt - gemerkt < SPAETER_GILT_MS;
}

/**
 * Was vor dem System-Dialog geschieht.
 *
 * **Drei Ausgänge, nicht zwei.** Die erste Fassung kannte nur „Erklärung
 * nötig: ja/nein", und der Aufrufer las „nein" als „ohne Erklärung
 * weitermachen". Für Mitteilungen ist das genau verkehrt: „keine Erklärung,
 * weil noch kein Anlass" und „keine Erklärung, weil schon ‚später' gesagt"
 * heissen beide „jetzt NICHT fragen" — gelesen als „weiter" öffneten sie den
 * System-Dialog ohne Blatt, also das, was dieser ganze Punkt verhindern
 * soll (Bughunt 2026-10-11, T6).
 */
export type Vorgehen =
  /** Ohne Blatt weitermachen: im Browser, oder die Lage ist schon entschieden
   *  (`erteilt`/`verweigert` — der Dialog erscheint dann gar nicht mehr). */
  | 'weiter'
  /** Erst das Blatt, dann je nach Antwort der System-Dialog. */
  | 'erklaeren'
  /** Jetzt gar nicht fragen, auch nicht ohne Blatt: kein Anlass, oder die
   *  Erklärung wurde schon mit „später" weggetippt. */
  | 'nicht';

export function vorgehenVorDemDialog(lage: Lage): Vorgehen {
  if (!lage.iosHuelle) return 'weiter';
  if (lage.stand !== 'offen') return 'weiter';
  // Nur dort, wo ein „später" überhaupt gemerkt wird — steht bei der Kamera
  // trotzdem ein Merker, darf er die Handlung nicht sperren.
  if (lage.schonAbgelehnt && ablehnungMerken(lage.art)) return 'nicht';
  if (lage.art === 'mitteilungen') {
    const anlass = lage.anlass === true || lage.sendungen >= SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE;
    return anlass ? 'erklaeren' : 'nicht';
  }
  return 'erklaeren';
}

/** In welcher Capacitor-Hülle die App läuft; `null` im Browser und in Electron. */
export type Huelle = 'ios' | 'android' | null;

/**
 * Fragt die Hülle beim START nach der Mitteilungs-Erlaubnis?
 *
 * **Android ja, iOS nein** (Eigentümer-Entscheid 2026-10-16). Auf iOS ist der
 * Dialog einmalig, deshalb fragt dort `fcm.ts::mitteilungenAnfragen` mit
 * Vorerklärung nach einem Anlass. Android behält den Weg, den es vor der
 * iOS-Hülle hatte: beim Start fragen, ohne Blatt, und keine zweite Frage nach
 * dem Senden.
 */
export function mitteilungenBeimStartFragen(huelle: Huelle): boolean {
  return huelle === 'android';
}

/** Fragt die Hülle NACH einer gesendeten Nachricht (mit Vorerklärung)? Nur
 *  iOS — das Gegenstück zu `mitteilungenBeimStartFragen`. */
export function mitteilungenNachAnlassFragen(huelle: Huelle): boolean {
  return huelle === 'ios';
}
