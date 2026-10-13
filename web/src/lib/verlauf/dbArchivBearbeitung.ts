/**
 * Der Datenbank-Durchlauf zu `archivBearbeitung.ts`: EIN Cursor über den
 * Kanal, gleich wie viele Bearbeitungs-Zeilen anstehen (die Frame-Suche
 * `dbLoeschen.ts::verlaufSatzIdsFuerFrame` liefe je Zeile einmal durch).
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort); die Regel steht
 * importfrei in `archivBearbeitung.ts`.
 */
import { STORE_NACHRICHTEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { gehoertZuKonto } from './kontoFilter';
import { kanalBereich } from './dbRegister';
import { bearbeitungFuerSatz, type ArchivBearbeitung } from './archivBearbeitung';

/** Wendet die Bearbeitungen auf die Sätze dieses Kontos im Kanal an und gibt
 *  die umgeschriebenen Sätze zurück. Wirft bei einem Fehlschlag. */
export function verlaufArchivBearbeitungen(
  kanalId: string,
  kontoId: string,
  bearbeitungen: Map<string, ArchivBearbeitung>
): Promise<Satz[]> {
  if (bearbeitungen.size === 0) return Promise.resolve([]);
  return mitVerbindung(
    (db) =>
      new Promise<Satz[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const geschrieben: Satz[] = [];
        const req = tx.objectStore(STORE_NACHRICHTEN).openCursor(kanalBereich(kanalId));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const satz = cursor.value as Satz;
          const neu = gehoertZuKonto(satz, kontoId) ? bearbeitungFuerSatz(satz, bearbeitungen) : null;
          if (neu) {
            cursor.update(neu);
            geschrieben.push(neu);
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve(geschrieben);
        tx.onerror = () => reject(tx.error);
      })
  );
}
