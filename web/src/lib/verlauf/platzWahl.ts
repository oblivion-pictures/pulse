/**
 * Wohin ein Nachschub-Satz gehört, wenn unter seinem Schlüssel schon ein Satz
 * eines ANDEREN Autors liegt — die Regel hinter
 * `dbErgaenzen.ts::verlaufSaetzeErgaenzen`.
 *
 * **Das Problem** (Gegenprüfung 2026-10-12, Fund 3). Eine Archiv-Zeile liegt
 * lokal unter ihrer eigenen ID `i` (`archiv/zeile.ts`), und die wählt der
 * Einliefernde frei. Bob liefert eine Zeile `{i: K_alice, a: Bob}` ein — sie
 * zählt, er ist ihr Einlieferer. Auf einem Gerät, das unter `K_alice` noch
 * nichts hat, belegte sie den Schlüssel, und Alices echte Zeile und später
 * ihr Satz aus der eigenen Sicherung fielen weg: ein anderer Autor unter
 * demselben Schlüssel überschreibt nichts (`satz.ts::satzErgaenzen`).
 *
 * **Gewählt: `i` bleibt die lokale ID, die Zeilen-ID ist der Ausweichplatz.**
 * Die beiden vorgeschlagenen Wege tragen hier nicht:
 *
 *   - Alle Archiv-Sätze unter der Zeilen-ID ablegen: die Zeilen-ID vergibt
 *     der Klient selbst, zufällig über 63 Bit (`archiv/kanalSchluessel.ts::
 *     erzeugeZufallsId`). Sie ordnet nicht nach der Zeit — jeder Satz aus dem
 *     Archiv stünde in Lesefenster und Anzeige an einer zufälligen Stelle.
 *     Und die eigene Archiv-Kopie läge nicht mehr unter dem Schlüssel des
 *     eigenen Satzes `K`, sondern als zweiter Satz daneben; jede eigene
 *     Bearbeitung und Reaktion träfe nur noch einen von beiden.
 *   - Den Autor in den Schlüssel nehmen: die Anzeige führt jede Nachricht
 *     unter ihrer ID, und jeder Weg vom Frame zum Satz rechnet den Schlüssel
 *     aus Kanal und ID (`satz.ts::sortierSchluessel`). Zwei Sätze mit
 *     derselben ID kann es dort nicht geben, und jeder bestehende Satz
 *     bekäme einen neuen Schlüssel.
 *
 * Deshalb bleibt alles, wie es liegt, solange kein anderer Autor denselben
 * Schlüssel beansprucht — Bestand, Lesestand und Duplikat-Erkennung ändern
 * sich nicht. Erst im Streitfall weicht eine Archiv-Zeile unter ihre
 * Zeilen-ID aus (`ausweichFassung`), mit `i` als `kryptoId`: ihre Identität
 * (Autor, Kennung) bleibt dieselbe, nur der Platz ist ein anderer. Die
 * Zeilen-ID wählt zwar auch der Klient, aber der Server hält sie eindeutig
 * (Primärschlüssel, `routes/archiv.py`): zwei Zeilen können denselben
 * Ausweichplatz nie beanspruchen. Der Preis: ein ausgewichener Satz steht in
 * der Anzeige an einer zufälligen Stelle — nur im Streitfall.
 *
 * Wer den Schlüssel bekommt:
 *
 *   - Die eigene Sicherung (`sicherung`) ist eigene Wahrheit: sie verdrängt
 *     einen Archiv-Satz eines anderen Autors, der verdrängte weicht aus.
 *   - Auf ihrem Ausweichplatz verdrängt eine Archiv-Zeile einen Archiv-Satz,
 *     der dort nur über seine eigene ID `i` sitzt — sonst könnte Bob auch den
 *     Ausweichplatz vorab mit einer Zeile `{i: R_alice}` belegen.
 *   - Sonst bleibt der liegende Satz, und eine Archiv-Zeile weicht aus.
 *
 * Importfrei bis auf `.ts`-Pfade (Nodes Testläufer).
 */
import type { Satz } from './schema.ts';
import { satzErgaenzen, sortierSchluessel, type Nachschub } from './satz.ts';

/** Was mit einem Nachschub-Satz geschieht. */
export type Platzwahl<S> =
  /** Unter seinem Schlüssel schreiben (`satz` ist die zu schreibende
   *  Fassung, gegebenenfalls schon ergänzt). */
  | { art: 'schreiben'; satz: S }
  /** Der liegende Satz bleibt, wie er ist. */
  | { art: 'nichts' }
  /** Unter dem Ausweichplatz versuchen (`ausweichFassung`). */
  | { art: 'ausweichen' }
  /** Schreiben und den liegenden Satz unter SEINEN Ausweichplatz schieben. */
  | { art: 'verdraengen'; satz: S; verdraengt: S };

/** Ob ein Satz aus dem Archiv kommt und unter seiner eigenen ID `i` liegt —
 *  nur ein solcher Platz ist strittig. */
function sitztUeberI(satz: Satz): satz is Satz & { archivZeile: string } {
  return satz.archivZeile !== undefined && satz.nachrichtId !== satz.archivZeile;
}

/** Ob ein Satz auf dem Ausweichplatz seiner Archiv-Zeile steht. */
function sitztAufAusweichplatz(satz: Satz): boolean {
  return satz.archivZeile !== undefined && satz.nachrichtId === satz.archivZeile;
}

/**
 * Die Entscheidung für `neu` gegen den Satz, der unter seinem Schlüssel
 * liegt (`vorhanden`, nur wenn er demselben Konto gehört — ein fremdes Konto
 * zählt wie „liegt nichts"). Ein Satz desselben Autors wird ergänzt
 * (`satzErgaenzen`); die übrigen Fälle stehen im Modulkopf.
 */
export function platzWaehlen<S extends Satz>(
  vorhanden: S | undefined,
  neu: S,
  herkunft: Nachschub
): Platzwahl<S> {
  if (vorhanden === undefined) return { art: 'schreiben', satz: neu };
  if (vorhanden.autorId === neu.autorId) {
    const ergaenzt = satzErgaenzen(vorhanden, neu, herkunft);
    return ergaenzt === null ? { art: 'nichts' } : { art: 'schreiben', satz: ergaenzt };
  }
  const verdraengbar =
    sitztUeberI(vorhanden) && (herkunft === 'sicherung' || sitztAufAusweichplatz(neu));
  if (verdraengbar) return { art: 'verdraengen', satz: neu, verdraengt: vorhanden };
  if (sitztUeberI(neu)) return { art: 'ausweichen' };
  return { art: 'nichts' };
}

/** Derselbe Satz auf dem Ausweichplatz seiner Archiv-Zeile: lokale ID = die
 *  Zeilen-ID, `i` als `kryptoId` (die Identität bleibt). `null` für einen
 *  Satz, der nicht aus dem Archiv kommt oder schon dort steht. */
export function ausweichFassung<S extends Satz>(satz: S): S | null {
  if (!sitztUeberI(satz)) return null;
  return {
    ...satz,
    schluessel: sortierSchluessel(satz.kanalId, satz.archivZeile),
    nachrichtId: satz.archivZeile,
    kryptoId: satz.kryptoId ?? satz.nachrichtId
  };
}
