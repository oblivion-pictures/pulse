/**
 * Die Bausteine des Grabstein-Registers (`grabsteinRegister.ts`) INNERHALB
 * einer offenen IndexedDB-Transaktion — damit Prüfen und Schreiben nie
 * auseinanderfallen. Zwischen dem Blick ins Register und dem Ablegen eines
 * Satzes darf keine Löschung durchrutschen, und zwischen dem Eintragen einer
 * Löschung und dem Markieren der liegenden Sätze kein Nachschub.
 *
 * Die Invariante, die beide Hälften zusammen halten: **steht eine Identität
 * im Register, liegt kein sichtbarer Satz mit ihr mehr da.** Wer einträgt,
 * markiert in derselben Transaktion (`gebundenLoeschenInTx`), und wer
 * ablegt, prüft in derselben Transaktion (`ablegenMitRegister`).
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort) — die Regeln
 * stehen importfrei in `grabsteinRegister.ts`, der Ablauf ist per E2E belegt
 * (`tests/e2e/verlauf-register.spec.ts`).
 */
import { medienZeilenAusSatz, type Satz } from './schema';
import { sortierSchluessel } from './satz';
import { gehoertZuKonto } from './kontoFilter';
import {
  alsGrabstein,
  registerEintrag,
  registerSchluesselFuerSatz,
  type RegisterEintrag
} from './grabsteinRegister';
import { trifftFrame } from '../krypto/loeschZiel';

/** Obere Grenze fuer den Primaerschluessel-Bereich eines Kanals ohne `vor` —
 *  20 Neunen sind lexikografisch groesser als jede echte gepolsterte ID
 *  (deren Ziffern hoechstens 9 sind), dient nur als Bereichsende. */
export const OBERE_ID = '9'.repeat(20);

/** Alle Sätze eines Kanals (Primärschlüssel-Bereich, `satz.ts::sortierSchluessel`). */
export function kanalBereich(kanalId: string): IDBKeyRange {
  return IDBKeyRange.bound(sortierSchluessel(kanalId, ''), sortierSchluessel(kanalId, OBERE_ID));
}

/**
 * Legt `satz` ab (put = Upsert über den Primärschlüssel) samt seiner
 * Medien-Zeilen — oder, steht seine Identität im Register, als Grabstein
 * (`alsGrabstein`, ohne Medien-Zeilen). `fertig` bekommt die abgelegte
 * Fassung. Ein Satz ohne Autor hat keine gebundene Identität und wird
 * abgelegt, wie er ist.
 */
export function ablegenMitRegister(
  nachrichten: IDBObjectStore,
  medien: IDBObjectStore,
  satz: Satz,
  fertig?: (abgelegt: Satz) => void
): void {
  const schreiben = (fassung: Satz): void => {
    nachrichten.put(fassung);
    for (const zeile of medienZeilenAusSatz(fassung)) medien.put(zeile);
    fertig?.(fassung);
  };
  const schluessel = satz.geloescht ? null : registerSchluesselFuerSatz(satz);
  if (schluessel === null) {
    schreiben(satz);
    return;
  }
  const anfrage = nachrichten.get(schluessel);
  anfrage.onsuccess = () => schreiben(anfrage.result !== undefined ? alsGrabstein(satz) : satz);
}

/**
 * Eine gebundene Löschung: trägt (Autor, Kennung) für jede Kennung ins
 * Register ein und markiert jeden sichtbaren Satz dieses Kontos, den ein
 * Lösch-Frame dieses Autors mit einer der Kennungen träfe
 * (`krypto/loeschZiel.ts::trifftFrame`) — auch, wenn gar keiner liegt: der
 * Eintrag allein hält eine später ankommende Kopie als Grabstein fest.
 * `fertig` bekommt die markierten Sätze und ob mindestens ein Eintrag neu war.
 *
 * Standen ALLE Einträge schon im Register, entfällt der Durchlauf durch den
 * Kanal: nach der Invariante im Modulkopf liegt dann kein sichtbarer
 * Treffer mehr. Das zählt, weil Archiv und Sicherung ihre Grabsteine bei
 * jedem Lesen erneut anwenden.
 */
export function gebundenLoeschenInTx(
  nachrichten: IDBObjectStore,
  kontoId: string,
  kanalId: string,
  autorId: string,
  kennungen: readonly string[],
  fertig: (markiert: Satz[], neuEingetragen: boolean) => void
): void {
  const eintraege = kennungen
    .map((kennung) => registerEintrag(kontoId, kanalId, autorId, kennung))
    .filter((e): e is RegisterEintrag => e !== null);
  if (eintraege.length === 0) {
    fertig([], false);
    return;
  }
  let offen = eintraege.length;
  let neuEingetragen = false;
  for (const eintrag of eintraege) {
    const anfrage = nachrichten.get(eintrag.schluessel);
    anfrage.onsuccess = () => {
      if (anfrage.result === undefined) {
        nachrichten.put(eintrag);
        neuEingetragen = true;
      }
      if (--offen > 0) return;
      if (!neuEingetragen) fertig([], false);
      else markiereTreffer(nachrichten, kontoId, kanalId, autorId, kennungen, (m) => fertig(m, true));
    };
  }
}

function markiereTreffer(
  nachrichten: IDBObjectStore,
  kontoId: string,
  kanalId: string,
  autorId: string,
  kennungen: readonly string[],
  fertig: (markiert: Satz[]) => void
): void {
  const markiert: Satz[] = [];
  const cursorAnfrage = nachrichten.openCursor(kanalBereich(kanalId));
  cursorAnfrage.onsuccess = () => {
    const cursor = cursorAnfrage.result;
    if (!cursor) {
      fertig(markiert);
      return;
    }
    const satz = cursor.value as Satz;
    const kandidat = { id: satz.nachrichtId, kryptoId: satz.kryptoId, autorId: satz.autorId };
    if (
      !satz.geloescht &&
      gehoertZuKonto(satz, kontoId) &&
      kennungen.some((kennung) => trifftFrame(kennung, kandidat, autorId))
    ) {
      const stein = { ...satz, geloescht: true };
      cursor.update(stein);
      markiert.push(stein);
    }
    cursor.continue();
  };
}
