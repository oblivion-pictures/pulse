/**
 * Die Räumwege des lokalen Verlaufs: ein Kanal (Entfreundung) oder alles
 * (verfallene Kopplung). Aus `db.ts` herausgelöst, das Lesen und Schreiben
 * der Sätze bleibt dort (Größen-Policy, `CLAUDE.md`).
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort).
 */
import { STORE_NACHRICHTEN, STORE_ANHAENGE, STORE_MEDIEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { OBERE_ID, sortierSchluessel } from './satz';

/**
 * Bughunt Runde 5: Alle Sätze (+ Anhang-Bytes) EINES Kanals verwerfen —
 * der einzige bisherige Räumweg war `verlaufAllesLoeschen` (Kopplungs-
 * Verfall). Entfernt sich ein Gespräch (Entfreundung), blieb der Klartext
 * samt entschluesselten Anhangs-Blobs sonst für die Geräte-Lebensdauer in
 * der IndexedDB und lieferte weiter lokale Suchtreffer.
 *
 * `kontoId`-Filter wie beim Grabstein: nur Sätze des laufenden Kontos —
 * ein Satz eines fremden Kontos unter derselben Kanal-ID bleibt unangetastet.
 * Invalide `kontoId` (`null`/'') → No-Op, sonst wäre das ein Flächenräumung.
 */
export function verlaufKanalVergessen(kanalId: string, kontoId: string): Promise<void> {
  if (!kanalId || !kontoId) return Promise.resolve();
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_NACHRICHTEN, STORE_ANHAENGE], 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const range = IDBKeyRange.bound(
          sortierSchluessel(kanalId, ''),
          sortierSchluessel(kanalId, OBERE_ID)
        );
        const satzSchluessel: string[] = [];
        const anhangIds: string[] = [];
        const req = store.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const satz = cursor.value as Satz;
          if (typeof satz.kontoId === 'string' && satz.kontoId === kontoId) {
            satzSchluessel.push(String(cursor.primaryKey));
            for (const a of Array.isArray(satz.anhaenge) ? satz.anhaenge : []) {
              const id = (a as { id?: unknown } | null)?.id;
              if (typeof id === 'string') anhangIds.push(id);
            }
            cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => {
          const anhangStore = db
            .transaction(STORE_ANHAENGE, 'readwrite')
            .objectStore(STORE_ANHAENGE);
          for (const id of anhangIds) anhangStore.delete(id);
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Loescht den GESAMTEN lokalen Verlauf dieses Geraets — Nachrichten,
 * Anhang-Bytes und den Medien-Index.
 *
 * Genau ein Aufrufer (`krypto/verfallPruefen.ts`): der gekoppelte Browser,
 * dessen Kopplung nach 14 Tagen ohne Benutzung abgelaufen ist (Spec §3a).
 * Der Fall, fuer den die Regel existiert, ist „auf einem fremden Rechner
 * gekoppelt und vergessen" — dort nuetzt es nichts, wenn nur die Schluessel
 * verfallen, waehrend der Verlauf liegen bleibt.
 *
 * **Ohne Konto-Filter, absichtlich.** Verfallen ist das GERAET, nicht ein
 * Konto darauf; ein halb geraeumter Speicher waere genau die Haelfte, die man
 * auf einem fremden Rechner nicht zuruecklassen will.
 *
 * Alle Speicher in EINER Transaktion: ein Abbruch dazwischen liesse sonst
 * die Anhang-Bytes ohne die Nachrichten stehen, die auf sie zeigen (und
 * seit Stufe B1 einen Medien-Index, der auf beides zeigt).
 */
export function verlaufAllesLoeschen(): Promise<void> {
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          [STORE_NACHRICHTEN, STORE_ANHAENGE, STORE_MEDIEN],
          'readwrite'
        );
        tx.objectStore(STORE_NACHRICHTEN).clear();
        tx.objectStore(STORE_ANHAENGE).clear();
        tx.objectStore(STORE_MEDIEN).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}
