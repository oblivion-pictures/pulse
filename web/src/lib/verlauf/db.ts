/**
 * Lesen und Schreiben im Verlauf — bleibt bewusst so dumm wie möglich, jede
 * Rechnung steckt in `satz.ts` / `schema.ts` / `kontoFilter.ts`. Das Öffnen
 * der Datenbank liegt daneben in `verbindung.ts`.
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort).
 *
 * Schreiben löst auf `tx.oncomplete` (durables Commit) auf, nicht auf
 * `req.onsuccess` (Schreibvorgang angenommen, aber noch nicht festgeschrieben
 * — zwischen beidem kann ein Absturz den Schreibvorgang stillschweigend
 * verwerfen).
 */
import {
  STORE_NACHRICHTEN,
  STORE_ANHAENGE,
  STORE_MEDIEN,
  INDEX_KANAL,
  type Satz,
  medienZeilenAusSatz
} from './schema';
import { mitVerbindung } from './verbindung';
import { sortierSchluessel, satzErgaenzen } from './satz';
import { gehoertZuKonto } from './kontoFilter';
import { trifftFrame } from '../krypto/loeschZiel';

// Medien-Index und Anhang-Bytes liegen in `dbAnhaenge.ts`; die Aufrufer
// importieren sie weiter von hier.
export {
  medienLesen,
  medienIdVorhanden,
  medienSchreiben,
  anhangBytesSichern,
  anhangBytesLesen,
  anhangBytesLoeschen
} from './dbAnhaenge';

/** Legt mehrere Sätze in einer einzigen Transaktion ab (put = Upsert über den
 *  Primärschlüssel — ein Grabstein überschreibt seine frühere Fassung).
 *
 *  Zweit-Schreibweg `medien` (Stufe B1): die Anhänge eines Satzes wandern
 *  als Index-Zeilen (`schema.ts::MedienZeile`) mit in dieselbe Transaktion.
 *  Das MUSS in den Schreibpforten passieren und nirgends sonst —
 *  `verlaufPutSaetze` (WS, Nachladen, Krypto-Empfang, Kopplung) und
 *  `verlaufSaetzeErgaenzen` (Sicherung, Server-Archiv, seit 2026-10-11)
 *  legen die Zeilen beide in derselben Transaktion an, der Medien-Index baut
 *  sich damit überall automatisch mit auf, ohne eigenen Code je Weg.
 *  Grabstein-Sätze liefern keine Zeilen (`medienZeilenAusSatz`); bestehende
 *  Index-Zeilen bleiben bei einem Grabstein stehen (der Nachzug darf sie
 *  weiter zeigen — der Server hat die Zeile ohnehin weggeräumt, sie ist hier
 *  der letzte Rest, bis B2 das aufräumt). */
export function verlaufPutSaetze(saetze: Satz[]): Promise<void> {
  if (saetze.length === 0) return Promise.resolve();
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_NACHRICHTEN, STORE_MEDIEN], 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const medien = tx.objectStore(STORE_MEDIEN);
        for (const satz of saetze) {
          store.put(satz);
          for (const zeile of medienZeilenAusSatz(satz)) medien.put(zeile);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Wie `verlaufPutSaetze`, aber ein schon liegender Satz wird ERGÄNZT statt
 * überschrieben (`satz.ts::satzErgaenzen`) — für die Wege, die fremden
 * Bestand nachliefern: Sicherungs-Wiederherstellung (`sicherung/andock.ts`)
 * und Server-Archiv (`archiv/lesen.ts` über `verlauf/index.ts`). Lesen und
 * Schreiben in EINER Transaktion (Muster `verlaufSatzUmschreiben`): zwischen
 * dem Blick auf den liegenden Satz und dem Schreiben darf kein Grabstein und
 * keine Bearbeitung dazwischenfahren, die das Schreiben dann überginge.
 *
 * Ein Satz eines FREMDEN Kontos unter demselben Schlüssel wird wie bisher
 * überschrieben — an dieser Stelle ändert sich gegenüber `verlaufPutSaetze`
 * nur der Fall „eigener Satz liegt schon da". Ergebnis: wie viele Sätze
 * geschrieben wurden.
 */
export function verlaufSaetzeErgaenzen(saetze: Satz[], kontoId: string): Promise<number> {
  if (saetze.length === 0) return Promise.resolve(0);
  return mitVerbindung(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const tx = db.transaction([STORE_NACHRICHTEN, STORE_MEDIEN], 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const medien = tx.objectStore(STORE_MEDIEN);
        let geschrieben = 0;
        for (const neu of saetze) {
          const getReq = store.get(neu.schluessel);
          getReq.onsuccess = () => {
            const vorhanden = getReq.result as Satz | undefined;
            const satz =
              vorhanden !== undefined && gehoertZuKonto(vorhanden, kontoId)
                ? satzErgaenzen(vorhanden, neu)
                : neu;
            if (satz === null) return;
            store.put(satz);
            for (const zeile of medienZeilenAusSatz(satz)) medien.put(zeile);
            geschrieben++;
          };
          getReq.onerror = () => reject(getReq.error);
        }
        tx.oncomplete = () => resolve(geschrieben);
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Markiert einen vorhandenen Satz als Grabstein (`geloescht: true`), ohne ihn
 * zu entfernen. `message_delete` trägt am WS nur `channel_id`+`id` — kein
 * `content`/`author_id`, also keine volle Nachricht, aus der `zuSatz` einen
 * Satz bauen könnte. Gab es lokal noch keinen Satz zu diesem Schlüssel
 * (Nachricht nie gesehen, z. B. ein Guild-Kanal), ist das ein stiller No-Op.
 *
 * `kontoId` (Befund 1, 2026-08-29): gehoert der vorgefundene Satz einem
 * ANDEREN Konto (`kontoFilter.ts::gehoertZuKonto`), bleibt er unangetastet —
 * ein fremder Grabstein waere selbst ein Schreibzugriff auf Daten, die dieses
 * Konto nicht sehen darf.
 *
 * `autorId` (2026-10-11): gesetzt, wenn die Löschung von einem Lösch-Frame
 * kommt — dann trifft sie nur einen Satz DIESES Autors, geprüft in derselben
 * Transaktion, in der geschrieben wird. Der Aufrufer bekommt seine Ziele
 * schon gebunden (`krypto/loeschZiel.ts`); die Prüfung hier ist die zweite
 * Wand, damit kein künftiger Aufrufer den Rückfall wieder einbaut, der am
 * 2026-10-11 fremde Lösch-Frames auf eigene Nachrichten durchließ.
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

/**
 * Schreibt einen vorhandenen Satz um — `umschreiben` bekommt den Satz und
 * liefert die neue Fassung oder `null` fuer „nichts zu tun". Lesen und
 * Schreiben in EINER Transaktion, damit zwei gleichzeitige Umschlaege (etwa
 * zwei Reaktionen im selben Abholzyklus) einander nicht ueberschreiben.
 * Gibt die geschriebene Fassung zurueck, sonst `null` (kein Satz, fremdes
 * Konto — s. `verlaufMarkiereGeloescht` —, oder `umschreiben` winkte ab).
 */
export function verlaufSatzUmschreiben(
  schluessel: string,
  kontoId: string,
  umschreiben: (satz: Satz) => Satz | null
): Promise<Satz | null> {
  return mitVerbindung(
    (db) =>
      new Promise<Satz | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        let neu: Satz | null = null;
        const getReq = store.get(schluessel);
        getReq.onsuccess = () => {
          const satz = getReq.result as Satz | undefined;
          if (!satz || !gehoertZuKonto(satz, kontoId)) return;
          neu = umschreiben(satz);
          if (neu) store.put(neu);
        };
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => resolve(neu);
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Prueft, ob unter diesem Primaerschluessel bereits ein Satz liegt —
 * fuer den Krypto-Empfangspfad (`krypto/empfangen.ts` FIX 3, Bughunt-Runde
 * 3, s. dortigen Modulkopf): scheitert nach erfolgreichem Ablegen NUR die
 * Quittung, kommt dieselbe Zustellung im naechsten Zyklus zurueck, aber die
 * Olm-Sitzung ist laengst ueber sie hinaus geratscht — ein zweiter
 * Entschluesselungsversuch scheitert dann grundsaetzlich. Ein Satz mit
 * demselben Schluessel ist der Beweis, dass GENAU DIESE Zustellung schon
 * einmal durch echtes Entschluesseln abgelegt wurde — sie darf dann ohne
 * erneutes Entschluesseln quittiert werden. Bewusst nur eine Existenzpruefung
 * gegen den bestehenden, selbst geschriebenen Bestand: kein neuer, vom Server
 * befuellbarer Vertrauens-Speicher (der Primaerschluessel selbst enthaelt die
 * vom Server vergebene Zustellungs-/Nachrichten-ID, aber ein Treffer bedeutet
 * nur "wir haben diesen Klartext schon einmal selbst hier abgelegt", nicht
 * "der Server behauptet etwas"). `kontoId` (Befund 1): ein Satz eines
 * ANDEREN Kontos zaehlt nicht als "vorhanden" — ohne die Pruefung wuerde
 * `krypto/empfangen.ts` eine echte Zustellung quittieren, deren Klartext
 * dieses Konto nie gesehen hat, nur weil zufaellig eine fremde Zeile unter
 * demselben Schluessel liegt.
 */
export function verlaufSatzVorhanden(
  kanalId: string,
  nachrichtId: string,
  kontoId: string
): Promise<boolean> {
  const schluessel = sortierSchluessel(kanalId, nachrichtId);
  return mitVerbindung(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const req = tx.objectStore(STORE_NACHRICHTEN).get(schluessel);
        req.onsuccess = () => {
          const satz = req.result as Satz | undefined;
          resolve(satz !== undefined && gehoertZuKonto(satz, kontoId));
        };
        req.onerror = () => reject(req.error);
      })
  );
}

/** Obere Grenze fuer den Primaerschluessel-Bereich eines Kanals ohne `vor` —
 *  20 Neunen sind lexikografisch groesser als jede echte gepolsterte ID
 *  (deren Ziffern hoechstens 9 sind), dient nur als Bereichsende. */
const OBERE_ID = '9'.repeat(20);

/**
 * Liest bis zu `anzahl` Saetze eines Kanals — laeuft ueber den PRIMAERschluessel
 * (`schluessel` beginnt mit `<kanalId>:`, s. `satz.ts::sortierSchluessel`),
 * kein Umweg ueber den `nach_kanal`-Index noetig, der Primaerschluessel
 * sortiert schon richtig. `vor` grenzt EXKLUSIV auf Saetze vor dieser
 * Nachrichten-ID ein (Hochscrollen); ohne `vor` sind es die neuesten
 * `anzahl` Saetze. Sammelt rueckwaerts (neueste zuerst) und dreht am Ende um
 * — die Reihenfolge, in der `MessageStore` sie erwartet.
 *
 * `kontoId` (Befund 1): der Primaerschluessel ist ausschliesslich nach
 * `kanalId` getrennt, nicht nach Konto — ein Satz eines FREMDEN Kontos unter
 * derselben `kanalId` (z. B. nach einem Kontowechsel auf demselben Geraet)
 * wird uebersprungen statt mitgezaehlt; er zaehlt auch nicht gegen `anzahl`.
 */
export function verlaufLesenSaetze(
  kanalId: string,
  opts: { vor?: string; anzahl: number },
  kontoId: string
): Promise<Satz[]> {
  if (opts.anzahl <= 0) return Promise.resolve([]);
  const untereGrenze = sortierSchluessel(kanalId, '');
  const obereGrenze =
    opts.vor !== undefined
      ? sortierSchluessel(kanalId, opts.vor)
      : sortierSchluessel(kanalId, OBERE_ID);
  const bereich = IDBKeyRange.bound(untereGrenze, obereGrenze, false, opts.vor !== undefined);

  return mitVerbindung(
    (db) =>
      new Promise<Satz[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const gefunden: Satz[] = [];
        const req = store.openCursor(bereich, 'prev');
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || gefunden.length >= opts.anzahl) {
            resolve(gefunden.reverse());
            return;
          }
          const satz = cursor.value as Satz;
          if (gehoertZuKonto(satz, kontoId)) gefunden.push(satz);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
  );
}

/**
 * Liest ALLE Saetze ueber ALLE Kanaele hinweg — fuer die lokale DM-Suche
 * (Etappe C5, `sucheLokal.ts`). Ein voller Scan, kein Bereich ueber den
 * `nach_kanal`-Index: die Suche ist kanaluebergreifend (WhatsApp-artig, wie
 * die serverseitige `GET /dm-channels-search`), IndexedDB hat keinen
 * Volltextindex ueber `inhalt`, und der Speicher ist auf den eigenen
 * DM-Verlauf EINES Nutzers begrenzt — vertretbar fuer eine Suchleiste, die
 * ohnehin per Tastendruck entprellt wird (`MobileChatsSuche.svelte`).
 *
 * `kontoId` (Befund 1): OHNE diesen Filter war genau das der Leck-Pfad — ein
 * voller Scan ueber ALLE Konten, die je auf diesem Geraet angemeldet waren.
 * Nur Saetze des angegebenen Kontos kommen zurueck.
 */
export function verlaufAlleLesen(kontoId: string): Promise<Satz[]> {
  return mitVerbindung(
    (db) =>
      new Promise<Satz[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const alle: Satz[] = [];
        const req = tx.objectStore(STORE_NACHRICHTEN).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(alle);
            return;
          }
          const satz = cursor.value as Satz;
          if (gehoertZuKonto(satz, kontoId)) alle.push(satz);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
  );
}

/** Der Satz unter dieser Nachrichten-ID, wenn er diesem Konto gehört —
 *  sonst `undefined`. */
export function verlaufSatzLesen(
  kanalId: string,
  nachrichtId: string,
  kontoId: string
): Promise<Satz | undefined> {
  const schluessel = sortierSchluessel(kanalId, nachrichtId);
  return mitVerbindung(
    (db) =>
      new Promise<Satz | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const anfrage = tx.objectStore(STORE_NACHRICHTEN).get(schluessel);
        anfrage.onsuccess = () => {
          const satz = anfrage.result as Satz | undefined;
          resolve(satz !== undefined && gehoertZuKonto(satz, kontoId) ? satz : undefined);
        };
        anfrage.onerror = () => reject(anfrage.error);
      })
  );
}

/** Die Anhang-IDs eines Satzes, oder `[]` — für den Grabstein-Weg, der die
 *  zugehörigen Anhang-Dateien aus Archiv und Geräte-Cache mitentfernen muss.
 *  Ein Anhang ohne `id` als Zeichenkette fällt heraus. */
export function satzAnhangIds(satz: Satz | undefined): string[] {
  const anhaenge = satz?.anhaenge;
  if (!Array.isArray(anhaenge)) return [];
  return anhaenge.flatMap((a) => {
    const id = a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? [id] : [];
  });
}

/** `satzAnhangIds` des Satzes unter dieser Nachrichten-ID (`verlaufSatzLesen`). */
export async function verlaufSatzAnhangIds(
  kanalId: string,
  nachrichtId: string,
  kontoId: string
): Promise<string[]> {
  return satzAnhangIds(await verlaufSatzLesen(kanalId, nachrichtId, kontoId));
}

/** Die lokalen Nachrichten-IDs aller Sätze, die ein Frame mit `frameId`
 *  trifft — für Lösch-, Reaktions- und Bearbeitungs-Frames (s.
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
  const bereich = IDBKeyRange.bound(
    sortierSchluessel(kanalId, ''),
    sortierSchluessel(kanalId, OBERE_ID)
  );
  return mitVerbindung(
    (db) =>
      new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const treffer: string[] = [];
        const req = tx.objectStore(STORE_NACHRICHTEN).openCursor(bereich);
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
