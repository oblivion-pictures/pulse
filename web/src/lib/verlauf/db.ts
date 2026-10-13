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
import { STORE_NACHRICHTEN, STORE_ANHAENGE, STORE_MEDIEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { sortierSchluessel, satzAnhangIds } from './satz';
import { gehoertZuKonto } from './kontoFilter';
import { serverWegDarfSchreiben } from './schreibRegel';
import { ablegenMitRegister, kanalBereich, OBERE_ID } from './dbRegister';
import { anhaengeVerwaistLoeschen } from './dbAnhaenge';

// Medien-Index und Anhang-Bytes liegen in `dbAnhaenge.ts`, `satzAnhangIds`
// in `satz.ts`; die Aufrufer importieren sie weiter von hier.
export {
  medienLesen,
  medienIdVorhanden,
  medienSchreiben,
  anhangBytesSichern,
  anhangBytesLesen,
  anhangBytesLoeschen,
  anhaengeVerwaistLoeschen
} from './dbAnhaenge';
export { satzAnhangIds } from './satz';
// Der Nachschub (Archiv, Sicherung) liegt in `dbErgaenzen.ts`.
export { verlaufSaetzeErgaenzen } from './dbErgaenzen';
// Die Lösch-Wege (mit Grabstein-Register) liegen in `dbLoeschen.ts`.
export {
  verlaufMarkiereGeloescht,
  verlaufGebundenLoeschen,
  verlaufSatzLoeschen,
  verlaufSatzIdsFuerFrame,
  verlaufRegisterAbgleichen
} from './dbLoeschen';

/** Legt mehrere Sätze in einer einzigen Transaktion ab (put = Upsert über den
 *  Primärschlüssel — ein Grabstein überschreibt seine frühere Fassung).
 *
 *  Grabstein-Register (2026-10-12, `grabsteinRegister.ts`): steht die
 *  Identität eines Satzes dort, landet er als Grabstein — in derselben
 *  Transaktion geprüft (`dbRegister.ts::ablegenMitRegister`). Ergebnis: die
 *  Nachrichten-IDs, die deshalb als Grabstein abgelegt wurden (der
 *  Empfangsweg zeigt sie nicht an und spiegelt sie nicht in die Sicherung).
 *
 *  `nurUeberKlartext` (Server-Weg, Gegenprüfung 2026-10-12 Fund 4): ein hier
 *  liegender VERSCHLÜSSELTER Satz desselben Kontos bleibt unangetastet. Der
 *  Server kennt keine verschlüsselte Nachricht (`Message.verschluesselt`
 *  setzt er nie), eine Server-Fassung unter demselben Schlüssel kann also
 *  nur eine Verwechslung oder eine Fälschung sein — blind darübergelegt,
 *  hob sie einen Grabstein auf und nahm Kennung und Reaktionen mit. Ebenso
 *  bleibt der Satz eines anderen Kontos desselben Profils (`schreibRegel.ts`).
 *
 *  Zweit-Schreibweg `medien` (Stufe B1): die Anhänge eines Satzes wandern
 *  als Index-Zeilen (`schema.ts::MedienZeile`) mit in dieselbe Transaktion.
 *  Das MUSS in den Schreibpforten passieren und nirgends sonst —
 *  `verlaufPutSaetze` (WS, Nachladen, Krypto-Empfang) und
 *  `verlaufSaetzeErgaenzen` (Sicherung, Server-Archiv, seit 2026-10-11;
 *  Kopplung seit 2026-10-12)
 *  legen die Zeilen beide in derselben Transaktion an, der Medien-Index baut
 *  sich damit überall automatisch mit auf, ohne eigenen Code je Weg.
 *  Grabstein-Sätze liefern keine Zeilen (`medienZeilenAusSatz`); bestehende
 *  Index-Zeilen bleiben bei einem Grabstein stehen (der Nachzug darf sie
 *  weiter zeigen — der Server hat die Zeile ohnehin weggeräumt, sie ist hier
 *  der letzte Rest, bis B2 das aufräumt). */
export function verlaufPutSaetze(
  saetze: Satz[],
  opts: { nurUeberKlartext?: boolean } = {}
): Promise<string[]> {
  if (saetze.length === 0) return Promise.resolve([]);
  return mitVerbindung(
    (db) =>
      new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction([STORE_NACHRICHTEN, STORE_MEDIEN], 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const medien = tx.objectStore(STORE_MEDIEN);
        const alsGrabstein: string[] = [];
        const ablegen = (satz: Satz): void =>
          ablegenMitRegister(store, medien, satz, (abgelegt) => {
            if (abgelegt.geloescht && !satz.geloescht) alsGrabstein.push(satz.nachrichtId);
          });
        for (const satz of saetze) {
          if (!opts.nurUeberKlartext) {
            ablegen(satz);
            continue;
          }
          const anfrage = store.get(satz.schluessel);
          anfrage.onsuccess = () => {
            if (serverWegDarfSchreiben(anfrage.result as Satz | undefined, satz)) ablegen(satz);
          };
        }
        tx.oncomplete = () => resolve(alsGrabstein);
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
 *
 * Die Anhang-Bytes gehen nur mit, wo kein verbliebener sichtbarer Satz sie
 * noch trägt — in einem anderen Kanal oder unter einem anderen Konto
 * (`dbAnhaenge.ts::anhaengeVerwaistLoeschen`, Gegenprüfung 2026-10-12,
 * Fund 2): eine Anhang-ID wählt der Absender frei, und ein Gesprächspartner
 * konnte die ID eines Anhangs aus einem anderen Gespräch in seine Nachricht
 * schreiben — das Vergessen seines Gesprächs nahm dann die Bytes des anderen
 * mit.
 *
 * Die Einträge des Grabstein-Registers (`grabsteinRegister.ts`) bleiben
 * stehen: sie tragen keinen Inhalt, nur Autor und Kennung, und halten eine
 * gelöschte Nachricht auch dann gelöscht, wenn der Kanal später wieder
 * Bestand bekommt (Archiv, Sicherung).
 */
export async function verlaufKanalVergessen(kanalId: string, kontoId: string): Promise<void> {
  if (!kanalId || !kontoId) return;
  const kandidaten = await mitVerbindung(
    (db) =>
      new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const anhangIds: string[] = [];
        const req = tx.objectStore(STORE_NACHRICHTEN).openCursor(kanalBereich(kanalId));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const satz = cursor.value as Satz;
          if (typeof satz.kontoId === 'string' && satz.kontoId === kontoId) {
            anhangIds.push(...satzAnhangIds(satz));
            cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(anhangIds);
        tx.onerror = () => reject(tx.error);
      })
  );
  await anhaengeVerwaistLoeschen(kandidaten);
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
