/**
 * Der Nachschub in den Verlauf — Sätze, die fremden Bestand nachliefern:
 * Sicherungs-Wiederherstellung (`sicherung/andockLesen.ts`), Kopplung
 * (`kopplung/empfangen.ts`) und Server-Archiv (`archiv/lesen.ts` über
 * `verlauf/index.ts`). Aus `db.ts` herausgelöst (2026-10-12); `db.ts` reicht
 * `verlaufSaetzeErgaenzen` durch.
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort) — die Regeln
 * stehen importfrei in `satz.ts`, der Ablauf ist per E2E belegt
 * (`tests/e2e/verlauf-register.spec.ts`).
 */
import { STORE_NACHRICHTEN, STORE_MEDIEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { nachSchluesselVerdichten, type Nachschub } from './satz';
import { nachschubFassung } from './schreibRegel';
import { ablegenMitRegister } from './dbRegister';

/**
 * Legt den Nachschub ab: ein schon liegender Satz desselben Kontos wird
 * ERGÄNZT statt überschrieben (`satz.ts::satzErgaenzen`). Ein Satz eines
 * anderen Autors unter demselben Schlüssel bleibt unangetastet, der Nachschub
 * fällt dann weg; besetzen kann ihn eine fremde Archiv-Zeile nicht mehr, sie
 * liegt unter ihrer Zeilen-ID (G2-3, Kopf von `archiv/zeile.ts`). Lesen und Schreiben in
 * EINER Transaktion (Muster `db.ts::verlaufSatzUmschreiben`): zwischen dem
 * Blick auf den liegenden Satz und dem Schreiben darf kein Grabstein und keine
 * Bearbeitung dazwischenfahren, die das Schreiben dann überginge.
 *
 * **Ein Satz nach dem anderen.** Jeder liest erst, wenn das `put` des vorigen
 * gestellt ist — sonst sähe ein Satz die Schreibvorgänge desselben Aufrufs
 * nicht (Gegenprüfung 2026-10-12, Fund 5 der ersten Runde). Gestellt ist es
 * erst im Rückruf von `ablegenMitRegister`, denn das liest vorher selbst das
 * Register; eine Leseanfrage, die davor gestellt würde, sähe den Satz nicht.
 * Was denselben Schlüssel teilt, legt `nachSchluesselVerdichten` vorher
 * zusammen.
 *
 * Ein Satz eines anderen Kontos desselben Browserprofils unter demselben
 * Schlüssel bleibt ebenfalls stehen (`schreibRegel.ts`). `herkunft` sagt,
 * wie viel der Nachschub ergänzen darf (`satz.ts::Nachschub`). Was
 * geschrieben wird, läuft durch das Grabstein-Register
 * (`dbRegister.ts::ablegenMitRegister`): eine gelöschte Nachricht kommt über
 * den Nachschub nicht zurück, auch nicht unter einer anderen lokalen ID.
 * Ergebnis: wie viele Sätze geschrieben wurden.
 */
export function verlaufSaetzeErgaenzen(
  saetze: Satz[],
  kontoId: string,
  herkunft: Nachschub
): Promise<number> {
  if (saetze.length === 0) return Promise.resolve(0);
  const reihe = nachSchluesselVerdichten(saetze, herkunft);
  return mitVerbindung(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const tx = db.transaction([STORE_NACHRICHTEN, STORE_MEDIEN], 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const medien = tx.objectStore(STORE_MEDIEN);
        let geschrieben = 0;
        const naechster = (i: number): void => {
          if (i >= reihe.length) return;
          const neu = reihe[i];
          const getReq = store.get(neu.schluessel);
          getReq.onsuccess = () => {
            const vorhanden = getReq.result as Satz | undefined;
            const satz = nachschubFassung(vorhanden, neu, kontoId, herkunft);
            if (satz === null) {
              naechster(i + 1);
              return;
            }
            ablegenMitRegister(store, medien, satz, () => {
              geschrieben++;
              naechster(i + 1);
            });
          };
          getReq.onerror = () => reject(getReq.error);
        };
        naechster(0);
        tx.oncomplete = () => resolve(geschrieben);
        tx.onerror = () => reject(tx.error);
      })
  );
}
