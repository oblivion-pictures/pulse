/**
 * Den abgelegten Satz EINER Nachricht in Anzeige-Form lesen — für den
 * Abholzyklus (`krypto/zyklusAuswerten.ts`, Push-Bughunt 2026-10-21,
 * Befund 1): eine Zustellung, die schon im Verlauf liegt, deren Quittung aber
 * zuletzt scheiterte, wird jetzt auch angezeigt statt nur quittiert.
 *
 * Derselbe Punkt-Lookup wie `db.ts::verlaufSatzVorhanden` und dieselbe
 * Umsetzung wie `index.ts::verlaufLesen` (Satz → Nachricht, Reaktionen mit
 * dem Konto) — eigene Datei, weil `db.ts` und `index.ts` an der
 * Größengrenze stehen. **Wirft bei einem Lesefehler**; der Aufrufer meldet
 * ihn und quittiert trotzdem (der Satz liegt ja).
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort).
 */
import type { Message } from '$lib/api/types';
import { STORE_NACHRICHTEN, type Satz } from './schema';
import { mitVerbindung } from './verbindung';
import { sortierSchluessel, satzZuNachricht } from './satz';
import { gehoertZuKonto } from './kontoFilter';
import { aktuellesKonto } from './konto';
import { reaktionenZuAggregat } from '../krypto/reaktionen';

/** `null`, wenn kein Satz dieses Kontos unter der ID liegt. */
export async function verlaufAbgelegteNachricht(
  kanalId: string,
  nachrichtId: string
): Promise<Message | null> {
  const kontoId = aktuellesKonto();
  if (kontoId === null) return null;
  const satz = await mitVerbindung(
    (db) =>
      new Promise<Satz | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const req = tx.objectStore(STORE_NACHRICHTEN).get(sortierSchluessel(kanalId, nachrichtId));
        req.onsuccess = () => resolve(req.result as Satz | undefined);
        req.onerror = () => reject(req.error);
      })
  );
  if (!satz || !gehoertZuKonto(satz, kontoId)) return null;
  const nachricht = satzZuNachricht(satz);
  const reactions = reaktionenZuAggregat(satz.reaktionen, kontoId);
  return reactions.length > 0 ? { ...nachricht, reactions } : nachricht;
}
