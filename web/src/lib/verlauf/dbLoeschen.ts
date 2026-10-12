/**
 * Die Lösch-Wege des Verlaufs — aus `db.ts` herausgelöst, als das
 * Grabstein-Register (`grabsteinRegister.ts`, `dbRegister.ts`) dazukam und
 * die Datei über die Größengrenze gewachsen wäre. `db.ts` reicht alles
 * unverändert durch.
 *
 * Drei Arten, eine Nachricht zu löschen, und sie unterscheiden sich darin,
 * woher der Autor kommt:
 *
 *   - `verlaufGebundenLoeschen`: der Autor steht fest, bevor ein Satz
 *     gelesen ist — Lösch-Frame, Grabstein-Zeile im Archiv, Sicherungs-Stein
 *     mit Autor. Trägt ins Register ein und markiert jede lokale Kopie.
 *   - `verlaufSatzLoeschen`: der Autor kommt aus dem liegenden Satz — die
 *     eigene Löschung und das Server-Ereignis. Ebenso mit Register.
 *   - `verlaufMarkiereGeloescht`: nur EIN Satz unter seinem Schlüssel, ohne
 *     Register. Für Sicherungs-Steine, die auch nach dem Leser
 *     (`sicherung/eintragsGruppen.ts`) keinen Autor tragen: sie treffen hier
 *     nur ihre lokale ID und lösen nie eine Identität auf.
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort).
 */
import { STORE_NACHRICHTEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { gehoertZuKonto } from './kontoFilter';
import { kanonischeId } from './identitaet';
import {
  istRegisterEintrag,
  registerEintragFuerSatz,
  registerSchluesselFuerSatz
} from './grabsteinRegister';
import { gebundenLoeschenInTx, kanalBereich } from './dbRegister';
import { trifftFrame } from '../krypto/loeschZiel';

/**
 * Markiert einen vorhandenen Satz als Grabstein (`geloescht: true`), ohne ihn
 * zu entfernen. Gab es lokal noch keinen Satz zu diesem Schlüssel, ist das
 * ein stiller No-Op.
 *
 * `kontoId` (Befund 1, 2026-08-29): gehoert der vorgefundene Satz einem
 * ANDEREN Konto (`kontoFilter.ts::gehoertZuKonto`), bleibt er unangetastet —
 * ein fremder Grabstein waere selbst ein Schreibzugriff auf Daten, die dieses
 * Konto nicht sehen darf.
 *
 * `autorId` (2026-10-11): gesetzt, trifft die Löschung nur einen Satz DIESES
 * Autors, geprüft in derselben Transaktion, in der geschrieben wird.
 *
 * Seit dem Register (2026-10-12) bleibt hier nur ein Aufrufer: der
 * Sicherungs-Stein ohne Autor (`sicherung/andockLesen.ts::steinAnwenden`).
 * Er trägt nichts ins Register ein — ohne Autor ist eine Löschung nicht
 * gebunden (`grabsteinRegister.ts`).
 *
 * Ergebnis: ob ein Grabstein gesetzt wurde.
 */
export function verlaufMarkiereGeloescht(
  schluessel: string,
  kontoId: string,
  autorId?: string
): Promise<boolean> {
  return mitVerbindung(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        let markiert = false;
        const getReq = store.get(schluessel);
        getReq.onsuccess = () => {
          const satz = getReq.result as Satz | undefined;
          if (!satz || satz.geloescht || !gehoertZuKonto(satz, kontoId)) return;
          if (autorId !== undefined && satz.autorId !== autorId) return;
          store.put({ ...satz, geloescht: true });
          markiert = true;
        };
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => resolve(markiert);
        tx.onerror = () => reject(tx.error);
      })
  );
}

/** Was eine gebundene Löschung ergab: die markierten Sätze und ob sie neu im
 *  Register steht. */
type GebundeneLoeschung = { markiert: Satz[]; neuEingetragen: boolean };

/**
 * Eine gebundene Löschung (s. Modulkopf): Register-Eintrag je Kennung und
 * Grabstein für jede lokale Kopie, in EINER Transaktion
 * (`dbRegister.ts::gebundenLoeschenInTx`). `kennungen` sind die IDs, unter
 * denen der Autor seine Nachricht kennt — beim Lösch-Frame und bei der
 * Grabstein-Zeile genau die kanonische Kennung, beim Sicherungs-Stein
 * zusätzlich seine lokale ID. Ergebnis: die markierten Sätze (für Anhänge
 * und Sicherungs-Steine des Aufrufers), leer, wenn keiner lag — und ob die
 * Löschung neu im Register steht (sonst war sie schon angewendet).
 */
export function verlaufGebundenLoeschen(
  kanalId: string,
  kontoId: string,
  autorId: string,
  kennungen: readonly string[]
): Promise<GebundeneLoeschung> {
  return mitVerbindung(
    (db) =>
      new Promise<GebundeneLoeschung>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        let ergebnis: GebundeneLoeschung = { markiert: [], neuEingetragen: false };
        gebundenLoeschenInTx(store, kontoId, kanalId, autorId, kennungen, (markiert, neu) => {
          ergebnis = { markiert, neuEingetragen: neu };
        });
        tx.oncomplete = () => resolve(ergebnis);
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Löscht den Satz unter `schluessel` — und mit ihm jede andere lokale Kopie
 * derselben Nachricht (Autor und kanonische Kennung aus dem Satz, Register-
 * Eintrag inklusive). Die Anzeige zeigt von zwei Kopien nur eine
 * (`identitaet.ts`); ohne das Mitlöschen stand nach dem nächsten Laden die
 * andere wieder da.
 *
 * `nurKlartext`: ein verschlüsselter Satz bleibt unangetastet — für Wege,
 * die nur über Klartext entscheiden dürfen (Server-Ereignisse). Ein Satz
 * ohne Autor wird nur selbst markiert, ohne Register.
 *
 * Ergebnis: die markierten Sätze, leer, wenn nichts zu tun war (kein Satz,
 * fremdes Konto, schon gelöscht, verschlüsselt bei `nurKlartext`).
 */
export function verlaufSatzLoeschen(
  schluessel: string,
  kontoId: string,
  nurKlartext: boolean
): Promise<Satz[]> {
  return mitVerbindung(
    (db) =>
      new Promise<Satz[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        let markiert: Satz[] = [];
        const anfrage = store.get(schluessel);
        anfrage.onsuccess = () => {
          const satz = anfrage.result as Satz | undefined;
          if (!satz || satz.geloescht || !gehoertZuKonto(satz, kontoId)) return;
          if (nurKlartext && satz.verschluesselt) return;
          // Der Satz selbst zuerst und unbedingt — er ist, was gelöscht
          // werden soll; der Durchlauf unten findet nur die übrigen Kopien.
          const stein = { ...satz, geloescht: true };
          store.put(stein);
          markiert = [stein];
          if (!satz.autorId) return;
          const kennung = kanonischeId(satz.nachrichtId, satz.kryptoId);
          gebundenLoeschenInTx(store, kontoId, satz.kanalId, satz.autorId, [kennung], (weitere) => {
            markiert = [stein, ...weitere];
          });
        };
        anfrage.onerror = () => reject(anfrage.error);
        tx.oncomplete = () => resolve(markiert);
        tx.onerror = () => reject(tx.error);
      })
  );
}

/** Die lokalen Nachrichten-IDs aller Sätze, die ein Frame mit `frameId`
 *  trifft — für Reaktions- und Bearbeitungs-Frames (s.
 *  `krypto/loeschZiel.ts`): ein empfangener Satz liegt unter der
 *  Zustellungs-ID und führt die Frame-ID als `kryptoId`, der eigene Satz
 *  des Verfassers (oder eine Archiv-Kopie) trägt sie als `nachrichtId`.
 *  Dieselbe Regel wie für die geladene Anzeige (`trifftFrame`), mit
 *  Autor-Bindung, sobald `autorId` gesetzt ist. Bereichs-Cursor über den
 *  Kanal wie in `verlaufLesenSaetze`; leer, wenn kein Satz dieses Kontos
 *  getroffen wird. */
export function verlaufSatzIdsFuerFrame(
  kanalId: string,
  frameId: string,
  kontoId: string,
  autorId?: string
): Promise<string[]> {
  return mitVerbindung(
    (db) =>
      new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const treffer: string[] = [];
        const req = tx.objectStore(STORE_NACHRICHTEN).openCursor(kanalBereich(kanalId));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(treffer);
            return;
          }
          const satz = cursor.value as Satz;
          const kandidat = { id: satz.nachrichtId, kryptoId: satz.kryptoId, autorId: satz.autorId };
          if (trifftFrame(frameId, kandidat, autorId) && gehoertZuKonto(satz, kontoId)) {
            treffer.push(satz.nachrichtId);
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
  );
}

/**
 * Gleicht Register und Grabstein-Sätze EINES Kontos ab — für die Kopplung
 * (`kopplung/empfangen.ts`), die den Verlauf des alten Geräts Satz für Satz
 * übernimmt. Dessen Register reist nicht mit, seine Grabsteine schon: jeder
 * Grabstein-Satz trägt hier seinen eigenen Autor und seine Kennung ein
 * (gebunden über den Satz selbst, nicht über eine fremde ID), und jeder
 * sichtbare Satz, dessen Identität danach im Register steht, wird Grabstein
 * — die Archiv-Kopie unter K, deren Empfangs-Satz unter D gelöscht war.
 * Zwei Durchläufe in EINER Transaktion: erst sammeln, dann markieren.
 * Ergebnis: wie viele Sätze markiert wurden.
 */
export function verlaufRegisterAbgleichen(kontoId: string): Promise<number> {
  return mitVerbindung(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const geloescht = new Set<string>();
        let markiert = 0;
        const sammeln = store.openCursor();
        sammeln.onsuccess = () => {
          const cursor = sammeln.result;
          if (!cursor) {
            markieren();
            return;
          }
          const zeile = cursor.value as unknown;
          if (istRegisterEintrag(zeile)) {
            if (zeile.grabstein.konto === kontoId) geloescht.add(zeile.schluessel);
          } else {
            const satz = zeile as Satz;
            const eintrag = satz.geloescht ? registerEintragFuerSatz(satz) : null;
            if (eintrag !== null && gehoertZuKonto(satz, kontoId) && !geloescht.has(eintrag.schluessel)) {
              store.put(eintrag);
              geloescht.add(eintrag.schluessel);
            }
          }
          cursor.continue();
        };
        const markieren = (): void => {
          const durchlauf = store.openCursor();
          durchlauf.onsuccess = () => {
            const cursor = durchlauf.result;
            if (!cursor) return;
            const satz = cursor.value as Satz;
            if (
              !istRegisterEintrag(satz) &&
              !satz.geloescht &&
              gehoertZuKonto(satz, kontoId) &&
              geloescht.has(registerSchluesselFuerSatz(satz) ?? '')
            ) {
              cursor.update({ ...satz, geloescht: true });
              markiert++;
            }
            cursor.continue();
          };
        };
        tx.oncomplete = () => resolve(markiert);
        tx.onerror = () => reject(tx.error);
      })
  );
}
