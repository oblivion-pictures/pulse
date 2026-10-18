/**
 * Holt die Dateien eines geteilten Pakets (iOS) aus dem Container der Hülle
 * und macht daraus `File`-Objekte für die Anhang-Pipeline — dieselbe, die auch
 * eine im Dialog gewählte Datei durchläuft (`VerfasserAnhaenge.hinzufuegen`,
 * also auch der verschlüsselte DM-Weg; an der Verschlüsselung ändert dies
 * nichts, es liefert nur die Dateien).
 *
 * **Sequenziell, Stück für Stück** (`naechstesStueck`): eine Datei nach der
 * anderen, ein Aufruf nach dem anderen. Die Brücke ist eine einzige
 * Warteschlange; zehn Dateien gleichzeitig verstopften sie.
 */
import { ShareReceiver } from '$lib/platform/shareReceiverPlugin';
import {
  base64ZuBytes,
  dateiName,
  naechstesStueck,
  type GeteilteDatei
} from './freigabeRechnung';

async function eineDatei(paketId: string, d: GeteilteDatei, nummer: number): Promise<File> {
  const teile: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (;;) {
    const laenge = naechstesStueck(offset, d.groesse);
    if (laenge === 0) break;
    const antwort = await ShareReceiver.leseDatei({ paketId, id: d.id, offset, laenge });
    const bytes = base64ZuBytes(antwort.base64);
    if (bytes.length === 0) throw new Error('leeres Stück');
    teile.push(bytes);
    offset += bytes.length;
    if (antwort.ende) break;
  }
  if (offset !== d.groesse) throw new Error('Datei unvollständig');
  return new File(teile, dateiName(d.name, d.mime, nummer), { type: d.mime });
}

/**
 * Lädt alle Dateien; eine, die nicht zu lesen ist, wird gezählt und
 * übersprungen — die übrigen kommen trotzdem an. Räumt am Ende die Hülle auf
 * (`abschliessen`), auch bei einem Fehler.
 */
export async function dateienLaden(
  paketId: string,
  dateien: GeteilteDatei[],
  fortschritt?: (fertig: number, gesamt: number) => void
): Promise<{ dateien: File[]; fehlgeschlagen: number }> {
  const geladen: File[] = [];
  let fehlgeschlagen = 0;
  try {
    for (const [i, d] of dateien.entries()) {
      try {
        geladen.push(await eineDatei(paketId, d, i + 1));
      } catch {
        fehlgeschlagen += 1;
      }
      fortschritt?.(i + 1, dateien.length);
    }
  } finally {
    try {
      await ShareReceiver.abschliessen({ paketId });
    } catch {
      // Die Hülle räumt nach 24 Stunden selbst auf.
    }
  }
  return { dateien: geladen, fehlgeschlagen };
}
