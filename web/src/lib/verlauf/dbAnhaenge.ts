/**
 * Die Anhang-Speicher des Verlaufs: geräteweiter Medien-Index (Stufe B1) und
 * entschlüsselte Anhang-Bytes (Etappe E) — aus `db.ts` herausgelöst
 * (2026-10-11), weil jene Datei über die Größengrenze gewachsen war; `db.ts`
 * reicht die Funktionen unverändert durch.
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort).
 */
import {
  STORE_ANHAENGE,
  STORE_MEDIEN,
  STORE_NACHRICHTEN,
  medienNeuesteZuerst,
  type AnhangBytes,
  type MedienZeile,
  type Satz
} from './schema';
import { mitVerbindung } from './verbindung';
import { gehoertZuKonto } from './kontoFilter';
import { satzAnhangIds } from './satz';

/**
 * Der geraeteweite Medien-Index dieses Kontos, neueste zuerst — fuer das
 * Medien-Archiv-Blatt (`MedienArchivSheet.svelte`), ein Lesezugriff
 * neben `verlaufAlleLesen`. Konto-gefiltert wie jeder Lesepfad
 * (`kontoFilter.ts`, fail-closed).
 *
 * Sortierung in JS ueber die Snowflake (Zeitordnung,
 * `schema.ts::medienNeuesteZuerst`, die auch Zeilen ohne gueltige Kennung
 * ueberspringt), nicht per Store-Cursor: der Primaerschluessel sortiert nur
 * lexikografisch, und Snowflakes verschiedener Ziffernlaengen (der
 * Generator-Epoch ist jung, die IDs wachsen in die naechste Stelle hinein)
 * wuerden dabei verkehrt herum liegen. ponytail: Voller Scan wie
 * `verlaufAlleLesen` — der Speicher traegt nur Metadaten-Zeilen eines
 * Kontos, keine Bytes.
 */
export function medienLesen(kontoId: string): Promise<MedienZeile[]> {
  return mitVerbindung(
    (db) =>
      new Promise<MedienZeile[]>((resolve, reject) => {
        const tx = db.transaction(STORE_MEDIEN, 'readonly');
        const zeilen: MedienZeile[] = [];
        const req = tx.objectStore(STORE_MEDIEN).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(medienNeuesteZuerst(zeilen));
            return;
          }
          const zeile = cursor.value as MedienZeile;
          if (gehoertZuKonto(zeile, kontoId)) zeilen.push(zeile);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
  );
}

/** Liegt unter dieser Anhang-ID schon eine Index-Zeile DES Kontos? — die
 *  Overlap-Frage des Nachzugs (`medienNachzug.ts`): der erste lokal
 *  bekannte Anhang beendet den Lauf, alles Dahinter ist ohnehin lokal. */
export function medienIdVorhanden(id: string, kontoId: string): Promise<boolean> {
  return mitVerbindung(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_MEDIEN, 'readonly');
        const req = tx.objectStore(STORE_MEDIEN).get(id);
        req.onsuccess = () => {
          const zeile = req.result as MedienZeile | undefined;
          resolve(zeile !== undefined && gehoertZuKonto(zeile, kontoId));
        };
        req.onerror = () => reject(req.error);
      })
  );
}

/** Upsert mehrerer Index-Zeilen in einer Transaktion — der Schreibweg des
 *  Nachzugs (`put` ueberschreibt gefahrlos, dieselbe Semantik wie in
 *  `verlaufPutSaetze`). */
export function medienSchreiben(zeilen: MedienZeile[]): Promise<void> {
  if (zeilen.length === 0) return Promise.resolve();
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_MEDIEN, 'readwrite');
        const store = tx.objectStore(STORE_MEDIEN);
        for (const zeile of zeilen) store.put(zeile);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Legt die entschluesselten Bytes eines Anhangs ab (Etappe E). `put` =
 * Upsert — ein zweiter Empfang derselben Kennung ueberschreibt gefahrlos.
 *
 * Der Aufrufer MUSS auf das Ergebnis warten, BEVOR er quittiert: nach der
 * Quittung gibt es die Bytes nirgends mehr (s. `schema.ts::AnhangBytes`).
 */
export function anhangBytesSichern(eintrag: AnhangBytes): Promise<void> {
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ANHAENGE, 'readwrite');
        tx.objectStore(STORE_ANHAENGE).put(eintrag);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/** Die abgelegten Bytes eines Anhangs, oder `undefined`. */
export function anhangBytesLesen(id: string): Promise<AnhangBytes | undefined> {
  return mitVerbindung(
    (db) =>
      new Promise<AnhangBytes | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_ANHAENGE, 'readonly');
        const req = tx.objectStore(STORE_ANHAENGE).get(id);
        req.onsuccess = () => resolve(req.result as AnhangBytes | undefined);
        req.onerror = () => reject(req.error);
      })
  );
}

/** Entfernt die Bytes eines Anhangs — fuer einen abgebrochenen oder aus dem
 *  Verfasser-Fenster wieder entfernten Upload. Ohne das bliebe die Datei
 *  eines nie abgeschickten Anhangs dauerhaft auf dem Geraet liegen. */
export function anhangBytesLoeschen(id: string): Promise<void> {
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ANHAENGE, 'readwrite');
        tx.objectStore(STORE_ANHAENGE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Löscht die Bytes der Anhänge unter `ids`, die kein sichtbarer Satz mehr
 * trägt, und nennt genau diese IDs — die Folge einer Löschung
 * (`loeschen.ts`, `db.ts::verlaufKanalVergessen`).
 *
 * **Warum nicht einfach die Anhänge des gelöschten Satzes** (Gegenprüfung
 * 2026-10-12, Fund 2): die Anhang-ID wählt der Absender frei. Bob kannte die
 * ID meines Bildes (er hat es von mir bekommen), lieferte eine Archiv-Zeile
 * mit ihr ein und löschte sie wieder — seine Löschung nahm die Bytes MEINES
 * Bildes von meinem Gerät, und die Laufwerk-Kopie gleich mit. Nach der
 * Quittung gibt es die Bytes nirgends sonst (`schema.ts::AnhangBytes`).
 *
 * Sichtbar heißt: kein Grabstein, gleich welches Konto — der Speicher
 * `anhaenge` ist geräteweit, nicht je Konto. Register-Einträge tragen keine
 * Anhänge. Prüfen und Löschen in EINER Transaktion, damit kein Satz mit
 * derselben ID dazwischen ankommt. Ein voller Durchlauf durch den Verlauf,
 * aber nur, wenn es überhaupt Kandidaten gibt — eine Löschung mit Anhang
 * ist selten.
 */
export function anhaengeVerwaistLoeschen(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return Promise.resolve(new Set());
  return mitVerbindung(
    (db) =>
      new Promise<Set<string>>((resolve, reject) => {
        const tx = db.transaction([STORE_NACHRICHTEN, STORE_ANHAENGE], 'readwrite');
        const verwaist = new Set(ids);
        const req = tx.objectStore(STORE_NACHRICHTEN).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            const anhaenge = tx.objectStore(STORE_ANHAENGE);
            for (const id of verwaist) anhaenge.delete(id);
            return;
          }
          const satz = cursor.value as Satz;
          if (!satz.geloescht) for (const id of satzAnhangIds(satz)) verwaist.delete(id);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve(verwaist);
        tx.onerror = () => reject(tx.error);
      })
  );
}
