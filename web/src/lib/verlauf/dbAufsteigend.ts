/**
 * Aufsteigend lesen, hinter einer Id — der Leseweg der Kanal-Festigung
 * (`ablage/verlaufQuelle.ts`). Die anderen Lesewege blättern rückwärts nach
 * der Zeit (`db.ts::verlaufLesenSaetze`); die Festigung braucht das
 * Gegenteil: alles hinter dem Wasserzeichen des Laufwerks, in der Ordnung
 * seiner Rahmen-Ids.
 *
 * **Ein Bereich-Cursor über den Primärschlüssel genügt**, weil er nur den
 * Snowflake-Bereich abdeckt: `sortierSchluessel` polstert die Id auf feste
 * Breite, innerhalb eines Bereichs ordnet der Schlüssel also nach der Zahl
 * (`zeitSeite.ts`, Kopf). Die obere Grenze liegt beim Aufrufer — er setzt sie
 * höchstens auf das Ende des Snowflake-Bereichs.
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort); die Auswahl
 * (`passt`) und das Fenster prüft `test/ablage-verlauf-quelle.test.ts` an der
 * Quelle, der Ablauf ist per E2E belegt (`tests/e2e/e2e-ablage-kanal.spec.ts`).
 */
import { STORE_NACHRICHTEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { sortierSchluessel } from './satz';
import { gehoertZuKonto } from './kontoFilter';

/**
 * Bis zu `anzahl` Sätze des Kanals mit `nach < id < bis` (beide exklusiv,
 * `nach === null`: vom Anfang), aufsteigend. Gezählt wird erst nach `passt`
 * und dem Konto-Filter — ein übersprungener Satz verbraucht keinen Platz,
 * sonst liefe eine Seite voller Grabsteine leer und der Aufrufer käme nie an
 * ihr vorbei.
 */
export function verlaufSaetzeAufsteigend(
  kanalId: string,
  nach: string | null,
  bis: string,
  anzahl: number,
  passt: (satz: Satz) => boolean,
  kontoId: string
): Promise<Satz[]> {
  if (anzahl <= 0) return Promise.resolve([]);
  const bereich = IDBKeyRange.bound(
    sortierSchluessel(kanalId, nach ?? '0'),
    sortierSchluessel(kanalId, bis),
    nach !== null,
    true
  );
  return mitVerbindung(
    (db) =>
      new Promise<Satz[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const req = tx.objectStore(STORE_NACHRICHTEN).openCursor(bereich, 'next');
        const gefunden: Satz[] = [];
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || gefunden.length >= anzahl) {
            resolve(gefunden);
            return;
          }
          const satz = cursor.value as Satz;
          if (gehoertZuKonto(satz, kontoId) && passt(satz)) gefunden.push(satz);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
  );
}
