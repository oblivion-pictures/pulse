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
 *     Register. Für Sicherungs-Steine ohne Autor: sie treffen nur ihre
 *     lokale ID und lösen nie eine Identität auf — der Grabstein trägt
 *     dafür `loeschungUngebunden`, damit auch eine spätere Kopplung ihn
 *     nicht einträgt.
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort).
 */
import { STORE_NACHRICHTEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { gehoertZuKonto } from './kontoFilter';
import { kanonischeId } from './identitaet';
import {
  istRegisterEintrag,
  registerSchluesselFuerSatz,
  uebernommeneLoeschungen
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
 * gebunden (`grabsteinRegister.ts`) —, und der Grabstein vermerkt das
 * (`loeschungUngebunden`): eine Kopplung trägt ihn sonst auf dem neuen
 * Gerät über Autor und Kennung des Satzes ein (Gegenprüfung 2026-10-14, V1).
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
          store.put({ ...satz, geloescht: true, loeschungUngebunden: true });
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
 * Trägt die Grabsteine ein, die die Kopplung (`kopplung/empfangen.ts`) vom
 * alten Gerät übernommen hat, und markiert jeden sichtbaren Satz desselben
 * Kontos mit derselben Identität — die Archiv-Kopie unter K, deren
 * Empfangs-Satz unter D auf dem alten Gerät gelöscht war. Das Register des
 * alten Geräts reist nicht mit, seine Grabstein-Sätze schon; jeder trägt
 * seinen eigenen Autor und seine Kennung ein, gebunden über den Satz selbst.
 *
 * **Nur die übernommenen Grabsteine** (Gegenprüfung 2026-10-12, Fund 7). Die
 * erste Fassung trug JEDEN Grabstein-Satz des Kontos ein, auch einen, der auf
 * diesem Gerät schon lag. Dazu gehören ungebundene Altlöschungen: ein
 * Sicherungs-Stein ohne Autor markiert nur den Satz unter seiner lokalen ID
 * (`sicherung/andockLesen.ts::steinAnwenden`) und löst bewusst keine
 * Identität auf. Nach einer Kopplung tat er es doch und nahm jede andere
 * Kopie derselben Nachricht mit.
 *
 * Ein ungebundener Grabstein (`loeschungUngebunden`, ein Sicherungs-Stein
 * ohne Autor auf dem alten Gerät) trägt nichts ein und markiert nur den Satz
 * unter seinem eigenen Schlüssel (`grabsteinRegister.ts::
 * uebernommeneLoeschungen`, Gegenprüfung 2026-10-14, V1).
 *
 * Eintragen und Markieren in EINER Transaktion, ein Durchlauf durch den
 * Speicher. Ergebnis: wie viele Sätze markiert wurden.
 */
export function verlaufRegisterAbgleichen(
  kontoId: string,
  grabsteine: readonly Satz[]
): Promise<number> {
  const { eintraege, nurSelbst } = uebernommeneLoeschungen(grabsteine, kontoId);
  if (eintraege.length === 0 && nurSelbst.size === 0) return Promise.resolve(0);
  const geloescht = new Set(eintraege.map((eintrag) => eintrag.schluessel));
  return mitVerbindung(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        // `put` überschreibt einen schon liegenden Eintrag mit demselben Inhalt.
        for (const eintrag of eintraege) store.put(eintrag);
        let markiert = 0;
        const durchlauf = store.openCursor();
        durchlauf.onsuccess = () => {
          const cursor = durchlauf.result;
          if (!cursor) return;
          const satz = cursor.value as Satz;
          if (!istRegisterEintrag(satz) && !satz.geloescht && gehoertZuKonto(satz, kontoId)) {
            if (nurSelbst.has(satz.schluessel)) {
              cursor.update({ ...satz, geloescht: true, loeschungUngebunden: true });
              markiert++;
            } else if (geloescht.has(registerSchluesselFuerSatz(satz) ?? '')) {
              cursor.update({ ...satz, geloescht: true });
              markiert++;
            }
          }
          cursor.continue();
        };
        durchlauf.onerror = () => reject(durchlauf.error);
        tx.oncomplete = () => resolve(markiert);
        tx.onerror = () => reject(tx.error);
      })
  );
}
