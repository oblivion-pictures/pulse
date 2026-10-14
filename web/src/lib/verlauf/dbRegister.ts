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
import {
  medienZeileDarfSchreiben,
  medienZeilenAusSatz,
  type MedienZeile,
  type Satz
} from './schema';
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
const OBERE_ID = '9'.repeat(20);

/** Alle Sätze eines Kanals (Primärschlüssel-Bereich, `satz.ts::sortierSchluessel`). */
export function kanalBereich(kanalId: string): IDBKeyRange {
  return IDBKeyRange.bound(sortierSchluessel(kanalId, ''), sortierSchluessel(kanalId, OBERE_ID));
}

/**
 * Legt `satz` ab (put = Upsert über den Primärschlüssel) samt seiner
 * Medien-Zeilen, soweit ihr Platz frei oder ihr eigener ist — oder, steht
 * seine Identität im Register, als Grabstein (`alsGrabstein`, ohne
 * Medien-Zeilen). `fertig` bekommt die abgelegte Fassung. Ein Satz ohne Autor
 * hat keine gebundene Identität und wird abgelegt, wie er ist.
 *
 * Die Medien-Prüfung sieht zuerst auf die Zeilen, die DIESE Transaktion
 * schon schreibt (`geplantIn`, Gegenprüfung 2026-10-14, W2): ein Stapel
 * (`verlaufPutSaetze`) stellt die `get` aller Sätze, bevor das `put` des
 * ersten aus seinem `onsuccess` entsteht — beide Prüfungen sähen sonst einen
 * freien Platz, und der letzte Satz gewänne. Die Rückrufe laufen in der
 * Reihenfolge der Anfragen, die Merkliste ist beim zweiten also gefüllt.
 */
export function ablegenMitRegister(
  nachrichten: IDBObjectStore,
  medien: IDBObjectStore,
  satz: Satz,
  fertig?: (abgelegt: Satz) => void
): void {
  const geplant = geplantIn(medien.transaction);
  const schreiben = (fassung: Satz): void => {
    nachrichten.put(fassung);
    // Eine Index-Zeile nur auf einen freien Platz oder über eine eigene
    // (`schema.ts::medienZeileDarfSchreiben`), geprüft in DIESER Transaktion.
    for (const zeile of medienZeilenAusSatz(fassung)) {
      const liegend = medien.get(zeile.id);
      liegend.onsuccess = () => {
        const vorher = geplant.get(zeile.id) ?? (liegend.result as MedienZeile | undefined);
        if (!medienZeileDarfSchreiben(vorher, zeile)) return;
        medien.put(zeile);
        geplant.set(zeile.id, zeile);
      };
    }
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

/** Die Medien-Zeilen, die eine Transaktion schon schreibt. An der
 *  Transaktion statt als Parameter, damit kein Aufrufer sie vergessen kann. */
const geplantJeTransaktion = new WeakMap<IDBTransaction, Map<string, MedienZeile>>();

function geplantIn(tx: IDBTransaction): Map<string, MedienZeile> {
  let geplant = geplantJeTransaktion.get(tx);
  if (geplant === undefined) {
    geplant = new Map();
    geplantJeTransaktion.set(tx, geplant);
  }
  return geplant;
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
 * jedem Lesen erneut anwenden. Nachgesehen wird dann nur noch unter den
 * Kennungen selbst (`markiereUnterKennung`): ein Tab, der nach einem Deploy
 * noch den Code von vor dem Register fährt, prüft beim Schreiben nichts
 * und kann die Archiv-Kopie unter K wieder sichtbar ablegen — der eine
 * Punktzugriff hält die Invariante für diesen Fall, ohne den Kanal je
 * Grabstein ganz zu lesen.
 */
export function gebundenLoeschenInTx(
  nachrichten: IDBObjectStore,
  kontoId: string,
  kanalId: string,
  autorId: string,
  kennungen: readonly string[],
  fertig: (markiert: Satz[], neuEingetragen: boolean) => void
): void {
  // Doppelte Kennungen (ein Sicherungs-Stein, dessen ID seine Kennung ist)
  // träfen denselben Satz zweimal.
  const eindeutig = [...new Set(kennungen)];
  const eintraege = eindeutig
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
      const markieren = neuEingetragen ? markiereTreffer : markiereUnterKennung;
      markieren(nachrichten, kontoId, kanalId, autorId, eindeutig, (m) => fertig(m, neuEingetragen));
    };
  }
}

/** Wie `markiereTreffer`, aber nur unter den Kennungen selbst als lokale ID
 *  — ein Punktzugriff je Kennung statt eines Durchlaufs durch den Kanal. */
function markiereUnterKennung(
  nachrichten: IDBObjectStore,
  kontoId: string,
  kanalId: string,
  autorId: string,
  kennungen: readonly string[],
  fertig: (markiert: Satz[]) => void
): void {
  const markiert: Satz[] = [];
  let offen = kennungen.length;
  for (const kennung of kennungen) {
    const anfrage = nachrichten.get(sortierSchluessel(kanalId, kennung));
    anfrage.onsuccess = () => {
      const satz = anfrage.result as Satz | undefined;
      if (satz && sichtbarerTreffer(satz, kontoId, autorId, kennungen)) {
        const stein = { ...satz, geloescht: true };
        nachrichten.put(stein);
        markiert.push(stein);
      }
      if (--offen === 0) fertig(markiert);
    };
  }
}

/** Ob ein liegender Satz eine gebundene Löschung mit diesen Kennungen trifft
 *  und noch sichtbar ist. */
function sichtbarerTreffer(
  satz: Satz,
  kontoId: string,
  autorId: string,
  kennungen: readonly string[]
): boolean {
  const kandidat = { id: satz.nachrichtId, kryptoId: satz.kryptoId, autorId: satz.autorId };
  return (
    !satz.geloescht &&
    gehoertZuKonto(satz, kontoId) &&
    kennungen.some((kennung) => trifftFrame(kennung, kandidat, autorId))
  );
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
    if (sichtbarerTreffer(satz, kontoId, autorId, kennungen)) {
      const stein = { ...satz, geloescht: true };
      cursor.update(stein);
      markiert.push(stein);
    }
    cursor.continue();
  };
}
