/**
 * Der Nachschub in den Verlauf — Sätze, die fremden Bestand nachliefern:
 * Sicherungs-Wiederherstellung (`sicherung/andockLesen.ts`), Kopplung
 * (`kopplung/empfangen.ts`) und Server-Archiv (`archiv/lesen.ts` über
 * `verlauf/index.ts`). Aus `db.ts` herausgelöst
 * (2026-10-12), als die Platzwahl dazukam (`platzWahl.ts`, Gegenprüfung
 * 2026-10-12, Fund 3); `db.ts` reicht `verlaufSaetzeErgaenzen` durch.
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort) — die Regeln
 * stehen importfrei in `satz.ts` und `platzWahl.ts`, der Ablauf ist per E2E
 * belegt (`tests/e2e/verlauf-register.spec.ts`).
 */
import { STORE_NACHRICHTEN, STORE_MEDIEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { nachSchluesselVerdichten, type Nachschub } from './satz';
import { gehoertZuKonto } from './kontoFilter';
import { ablegenMitRegister } from './dbRegister';
import { ausweichFassung, platzWaehlen } from './platzWahl';

/**
 * Legt den Nachschub ab: ein schon liegender Satz desselben Autors wird
 * ERGÄNZT statt überschrieben (`satz.ts::satzErgaenzen`), ein Satz eines
 * anderen Autors unter demselben Schlüssel entscheidet die Platzwahl
 * (`platzWahl.ts`). Lesen und Schreiben in EINER Transaktion (Muster
 * `db.ts::verlaufSatzUmschreiben`): zwischen dem Blick auf den liegenden Satz
 * und dem Schreiben darf kein Grabstein und keine Bearbeitung dazwischenfahren,
 * die das Schreiben dann überginge.
 *
 * **Ein Satz nach dem anderen.** Jeder liest erst, wenn der vorige geschrieben
 * hat — sonst sähe ein Satz die Schreibvorgänge desselben Aufrufs nicht
 * (Gegenprüfung 2026-10-12, Fund 5 der ersten Runde), und zwei Zeilen
 * verschiedener Autoren unter derselben ID liefen beide gegen „liegt
 * nichts". Was denselben Schlüssel und Autor teilt, legt
 * `nachSchluesselVerdichten` vorher zusammen.
 *
 * Ein Satz eines FREMDEN Kontos unter demselben Schlüssel zählt wie „liegt
 * nichts" und wird überschrieben, wie in `verlaufPutSaetze`. `herkunft` sagt,
 * wie viel der Nachschub ergänzen und wen er verdrängen darf
 * (`satz.ts::Nachschub`). Was geschrieben wird, läuft durch das
 * Grabstein-Register (`dbRegister.ts::ablegenMitRegister`): eine gelöschte
 * Nachricht kommt über den Nachschub nicht zurück, auch nicht unter einer
 * anderen lokalen ID oder auf einem Ausweichplatz. Ergebnis: wie viele Sätze
 * geschrieben wurden (ein verdrängter, der ausweicht, zählt nicht mit).
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
        const platz = new Platzierer(
          tx.objectStore(STORE_NACHRICHTEN),
          tx.objectStore(STORE_MEDIEN),
          kontoId,
          herkunft,
          reject
        );
        let geschrieben = 0;
        const naechster = (i: number): void => {
          if (i >= reihe.length) return;
          platz.ablegen(reihe[i], (anzahl) => {
            geschrieben += anzahl;
            naechster(i + 1);
          });
        };
        naechster(0);
        tx.oncomplete = () => resolve(geschrieben);
        tx.onerror = () => reject(tx.error);
      })
  );
}

/** Die Schritte der Platzwahl innerhalb EINER offenen Transaktion. */
class Platzierer {
  constructor(
    private readonly nachrichten: IDBObjectStore,
    private readonly medien: IDBObjectStore,
    private readonly kontoId: string,
    private readonly herkunft: Nachschub,
    private readonly fehler: (err: unknown) => void
  ) {}

  /** Der Satz unter `schluessel`, wenn er diesem Konto gehört. */
  private lesen(schluessel: string, weiter: (satz: Satz | undefined) => void): void {
    const anfrage = this.nachrichten.get(schluessel);
    anfrage.onsuccess = () => {
      const satz = anfrage.result as Satz | undefined;
      weiter(satz !== undefined && gehoertZuKonto(satz, this.kontoId) ? satz : undefined);
    };
    anfrage.onerror = () => this.fehler(anfrage.error);
  }

  /** Schreibt über das Grabstein-Register. `weiter` erst, wenn das `put`
   *  gestellt ist: `ablegenMitRegister` liest vorher das Register, und eine
   *  Leseanfrage, die davor gestellt wird, sähe den Satz nicht. */
  private schreiben(satz: Satz, weiter: () => void): void {
    ablegenMitRegister(this.nachrichten, this.medien, satz, weiter);
  }

  /** Legt `neu` nach der Platzwahl ab; `fertig` bekommt, wie viele Sätze
   *  dabei geschrieben wurden: 1 für `neu` (oder seine ergänzte Fassung), 0
   *  sonst — ein verdrängter Satz, der ausweicht, zählt nicht mit. */
  ablegen(neu: Satz, fertig: (anzahl: number) => void): void {
    this.lesen(neu.schluessel, (vorhanden) => {
      const wahl = platzWaehlen(vorhanden, neu, this.herkunft);
      switch (wahl.art) {
        case 'schreiben':
          this.schreiben(wahl.satz, () => fertig(1));
          return;
        case 'ausweichen': {
          const ausweich = ausweichFassung(neu);
          if (ausweich === null) fertig(0);
          else this.ablegen(ausweich, fertig);
          return;
        }
        case 'verdraengen': {
          const verdraengt = ausweichFassung(wahl.verdraengt);
          this.schreiben(wahl.satz, () => this.wennFrei(verdraengt, () => fertig(1)));
          return;
        }
        case 'nichts':
          fertig(0);
      }
    });
  }

  /** Legt einen verdrängten Satz auf seinen Ausweichplatz, wenn dort nichts
   *  liegt — sonst entfällt er hier; seine Zeile bleibt im Archiv, und ein
   *  erneutes Lesen führt sie wieder durch die Platzwahl (der Lesestand liegt
   *  nur im Speicher, `archiv/lesen.ts`). Eine Kette von Verdrängungen gibt
   *  es so nicht. */
  private wennFrei(satz: Satz | null, weiter: () => void): void {
    if (satz === null) {
      weiter();
      return;
    }
    const anfrage = this.nachrichten.get(satz.schluessel);
    anfrage.onsuccess = () => {
      if (anfrage.result === undefined) this.schreiben(satz, weiter);
      else weiter();
    };
    anfrage.onerror = () => this.fehler(anfrage.error);
  }
}
