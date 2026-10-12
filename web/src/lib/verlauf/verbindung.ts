/**
 * Die Verbindung zur Verlaufs-Datenbank — die einzige Stelle in `verlauf/`,
 * die `indexedDB` selbst oeffnet. Deshalb im Node-Testlaeufer NICHT pruefbar
 * (kein `indexedDB` dort); bleibt bewusst so dumm wie moeglich.
 *
 * Aus `db.ts` herausgeschnitten, als die Datei ueber die Groessen-Grenze
 * wuchs (`CLAUDE.md` §Konventionen). Der Schnitt liegt an einer echten Naht:
 * hier steht das Oeffnen und Wiederverbinden, dort die Lese- und
 * Schreibvorgaenge — `db.ts` kommt seither mit `mitVerbindung` aus und
 * kennt weder `indexedDB.open` noch den Wiederverbindungs-Rennlauf.
 *
 * Muster wie `lib/identity/idb-shared.ts`: eine geteilte, zwischengespeicherte
 * Verbindung.
 */
import { DB_NAME, DB_VERSION, STORE_NACHRICHTEN, STORE_ANHAENGE, STORE_MEDIEN, INDEX_KANAL } from './schema';
import { melde } from '$lib/diagnose/app-diagnose';
import { verlaufZustand } from './zustand.svelte';

let _dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Der Riegel (Gegenprüfung 2026-10-12, R3): der Bestand ist jünger als dieser
 * Code, ein anderer Tab hat die Fassung angehoben. Ab dann ist der lokale
 * Verlauf in diesem Tab bis zum Neuladen aus — jeder Zugriff scheitert, und
 * genau das darf nicht still geschehen.
 *
 * Für verschlüsselte Nachrichten ist der lokale Verlauf die einzige Kopie, und
 * ihre Sitzungen liegen in einer ANDEREN Datenbank (`pulse-identity`), die der
 * Fassungswechsel nicht berührt. Ohne Riegel entschlüsselte der alte Tab eine
 * Zustellung weiter, sicherte die weitergedrehte Sitzung, scheiterte am
 * Ablegen und quittierte nicht — danach konnte KEIN Tab den Umschlag mehr
 * öffnen. Wer etwas dauerhaft ablegen muss, fragt deshalb vorher
 * `verlaufVerriegelt()` und lässt dann alles liegen: der Postfach-Zyklus
 * (`krypto/empfangen.ts`, `krypto/zustellungOeffnen.ts`), die
 * Gruppen-Zustellung (`krypto/gruppe/empfangen.ts`) und jedes eigene Senden
 * (`verlaufRiegelPruefen`).
 *
 * Gesetzt wird er beim ersten `VersionError` und schon dann, wenn ein anderer
 * Tab eine höhere Fassung ANFORDERT (`onversionchange` unten) — das ist der
 * früheste Zeitpunkt, und ein Zyklus, der gerade läuft, prüft ihn danach
 * erneut. Ganz schließt das die Lücke nicht: eine Zustellung, die schon
 * entschlüsselt ist, wenn die Anforderung kommt, scheitert beim Ablegen
 * trotzdem. Er fällt nie wieder: der neu geladene Code kennt die Fassung.
 */
let verriegelt = false;

function verriegeln(): void {
  if (verriegelt) return;
  verriegelt = true;
  console.warn('[verlauf] lokale Datenbank in höherer Fassung — bitte neu laden');
  melde('verlauf', 'verlauf_zu_neu', 'Bestand jünger als App (VersionError), nichts gelöscht', {
    code_version: DB_VERSION
  });
  verlaufZustand.verriegeln();
}

/** Ob der lokale Verlauf in diesem Tab verriegelt ist (s. `verriegelt`). */
export function verlaufVerriegelt(): boolean {
  return verriegelt;
}

/** Was ein eigenes Senden wirft, solange der Riegel steht. Der Name ist
 *  `VersionError`, damit `speicherfehler.ts` ihn wie den Auslöser deutet. */
export class VerlaufVerriegelt extends Error {
  constructor() {
    super('Lokaler Verlauf pausiert — eine neuere App-Fassung hat ihn geöffnet. Bitte neu laden.');
    this.name = 'VersionError';
  }
}

/** Wirft `VerlaufVerriegelt`, solange der Riegel steht — für jeden eigenen
 *  Sendeweg, VOR dem ersten Schritt, der eine Sitzung weiterdreht. */
export function verlaufRiegelPruefen(): void {
  if (verriegelt) throw new VerlaufVerriegelt();
}

function _openFresh(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NACHRICHTEN)) {
        const store = db.createObjectStore(STORE_NACHRICHTEN, { keyPath: 'schluessel' });
        store.createIndex(INDEX_KANAL, 'kanalId');
      }
      // Fassung 2 (Etappe E). Die `contains`-Wache ist kein Zierrat: dieser
      // Block laeuft auch bei einer Neuanlage (0 -> 2), wo der Speicher oben
      // gerade erst entstanden ist, und bei einem Aufstieg 1 -> 2, wo nur
      // dieser hier fehlt. `createObjectStore` auf einen vorhandenen Namen
      // wirft.
      if (!db.objectStoreNames.contains(STORE_ANHAENGE)) {
        const anhaenge = db.createObjectStore(STORE_ANHAENGE, { keyPath: 'id' });
        anhaenge.createIndex(INDEX_KANAL, 'kanalId');
      }
      // Fassung 3 (Medien-Nachziehen, Stufe B1). Dieselbe Wache wie oben:
      // dieser Block laeuft auch bei 0 -> 3 (Neuanlage) und 1 -> 3 / 2 -> 3
      // gleichermaassen, und der Speicher traegt nur `kontoId`-pflichtige
      // Zeilen (`schema.ts::MedienZeile`) — kein zweiter Index noetig; die
      // Snowflake-Zeitordnung fuer die Anzeige baut `medienLesen` in JS
      // (der Primaerschluessel sortiert nur lexikografisch).
      if (!db.objectStoreNames.contains(STORE_MEDIEN)) {
        db.createObjectStore(STORE_MEDIEN, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const realClose = db.close.bind(db);
      db.onversionchange = (ereignis) => {
        // Ein anderer Tab hebt die Fassung an: der nächste Zugriff hier trifft
        // `VersionError`. Riegel schon jetzt (s. `verriegelt`). `newVersion`
        // ist `null`, wenn die Datenbank gelöscht wird („Öffentlicher
        // Computer") — danach legt dieser Code sie wieder an, kein Riegel.
        if (ereignis.newVersion !== null && ereignis.newVersion > DB_VERSION) verriegeln();
        _dbPromise = null;
        realClose();
      };
      (db as IDBDatabase & { close: () => void }).close = () => {
        /* geteilte Verbindung — bewusster No-Op */
      };
      resolve(db);
    };
    req.onerror = () => {
      try {
        req.result?.close();
      } catch {
        /* ignorieren */
      }
      _dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      _dbPromise = null;
      reject(new Error('IDB blockiert — andere Verbindung offen'));
    };
  });
}

/**
 * Öffnet die geteilte Verbindung. **Eine höhere Fassung wird nie gelöscht.**
 *
 * Bis 2026-10-12 stand hier die „Fassungs-Stau-Heilung" (seit 2026-09-22):
 * fand das Öffnen einen Bestand in HÖHERER Fassung vor (`VersionError`),
 * löschte sie die ganze Datenbank und legte sie neu an. Gedacht war das für
 * Profile, die einmal einen Experimentier-Zweig geladen hatten. Getroffen
 * hätte es aber jeden Tab, der nach einem Deploy noch den alten Code fährt,
 * sobald ein neuer Tab die Fassung anhebt — und für verschlüsselte
 * Nachrichten ist der lokale Verlauf die einzige Kopie (Gegenprüfung
 * 2026-10-12, Fund 5). Der Blockier-Schutz griff nicht: der neue Tab schließt
 * seine Verbindung in `onversionchange` selbst, das Löschen lief also durch,
 * und der neue Tab legte danach eine leere Datenbank an. Ebenso nach einem
 * Rückroll-Deploy oder mit einem offenen Electron-Fenster der alten Fassung.
 *
 * Jetzt fällt `VersionError` durch und setzt den Riegel (`verriegelt`):
 * `speicherfehler.ts` deutet ihn als `zu_neu`, die Oberfläche bittet dauerhaft
 * um ein Neuladen (`zustand.svelte.ts`, Banner in `routes/app/+layout.svelte`),
 * und der neu geladene Code kennt die Fassung. Bis dahin läuft der Tab ohne
 * lokalen Verlauf; was er dabei nicht verlieren darf, hält der Riegel fest
 * (mit der Lücke, die dort steht). Ein Profil, das wirklich einen
 * jüngeren Bestand aus einem Experimentier-Zweig hält, räumt man von Hand —
 * etwa über „Öffentlicher Computer" in den Einstellungen, das allerdings ALLE
 * lokalen Daten dieses Geräts löscht und abmeldet. Die App löscht den
 * Bestand nie selbst.
 */
function openVerlaufDb(): Promise<IDBDatabase> {
  if (!_dbPromise) {
    const versuch = _openFresh().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'VersionError') verriegeln();
      throw err;
    });
    // Ein abgelehnter Versuch darf nicht kleben: sonst wehrt ein gespeicherter
    // Fehler jeden künftigen Aufruf mit demselben Text ab, ohne es je erneut
    // zu versuchen. `_openFresh()` setzt sich selbst zurück (req.onerror);
    // dieser Fang sichert die Kette darüber. `.catch` schluckt nichts — die
    // Ablehnung läuft zum Aufrufer weiter.
    versuch.catch(() => {
      if (_dbPromise === versuch) _dbPromise = null;
    });
    _dbPromise = versuch;
  }
  return _dbPromise;
}

/**
 * Fuehrt `aktion` gegen die geteilte Verbindung aus — und heilt EINEN
 * konkreten Rennlauf selbst: `db.onversionchange` oben schliesst die
 * Verbindung wirklich (`realClose()`) und setzt `_dbPromise = null`, aber
 * ein Aufrufer kann seine `IDBDatabase`-Referenz schon VOR dem Reset
 * gehalten haben — `db.transaction()` darauf wirft dann synchron
 * `InvalidStateError`.
 *
 * Seit `DB_VERSION` auf 2 steht (Etappe E, neuer Speicher `anhaenge`) ist das
 * kein theoretischer Fall mehr: ein zweiter Tab mit der alten Fassung der App
 * haelt eine Verbindung auf Fassung 1, der Aufstieg loest dort ein echtes
 * `onversionchange` aus. Der frueher hier stehende Satz „kann heute nicht
 * auftreten" galt nur, solange die Nummer nie stieg.
 *
 * Ohne diese Absicherung landete der Fehler unveraendert bei
 * `speicherfehler.ts::deuteSpeicherfehler`, das JEDES `InvalidStateError`
 * als "privater Modus" deutet (Safari wirft dasselbe bei echter
 * Nichtverfuegbarkeit) — ein voruebergehendes Rennen sah dann dauerhaft wie
 * ein blockierter Browser aus, obwohl ein einfacher Neuversuch reicht.
 *
 * Die Unterscheidung "Rennen vs. echte Nichtverfuegbarkeit" haengt NICHT an
 * der Fehlerart (beide sind `InvalidStateError`), sondern daran, ob
 * `_dbPromise` sich seit dem Beginn dieses Aufrufs veraendert hat: nur dann
 * war es das `onversionchange`-Rennen. Ein `_openFresh()`-Fehlschlag beim
 * NEUEN Versuch (z. B. tatsaechlich privater Modus) faellt dagegen normal
 * durch — kein zweiter, sinnloser Neuversuch.
 */
export async function mitVerbindung<T>(aktion: (db: IDBDatabase) => Promise<T>): Promise<T> {
  // Verriegelt: nicht erst öffnen — ein Öffnen gelänge sonst noch, solange
  // der andere Tab seine Anhebung nicht abgeschlossen hat.
  if (verriegelt) throw new DOMException('Bestand jünger als dieser Code', 'VersionError');
  const versucht = openVerlaufDb();
  const db = await versucht;
  try {
    return await aktion(db);
  } catch (err) {
    const warRennen =
      err instanceof DOMException && err.name === 'InvalidStateError' && _dbPromise !== versucht;
    if (!warRennen) throw err;
    const frischeDb = await openVerlaufDb();
    return aktion(frischeDb);
  }
}
