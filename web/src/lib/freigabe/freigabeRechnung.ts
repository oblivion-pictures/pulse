/**
 * Die Rechnung hinter dem Teilen-Empfang (iOS, mehrere Dateien) — importfrei,
 * damit der Node-Testlauf sie prüft, ohne Capacitor zu laden. Die Brücke
 * (`platform/shareEmpfang.ts`) und das Laden der Dateien
 * (`freigabeDateien.ts`) bleiben dünn und rufen nur dies.
 *
 * **Warum Stücke.** Die Dateien liegen im Container der Hülle; Base64 über die
 * Capacitor-Brücke trägt keine 25 MiB am Stück, und eine verstopfte Brücke hat
 * die App schon einmal einfrieren lassen. `ShareReceiver.leseDatei` liefert
 * deshalb höchstens `STUECK_BYTES` je Aufruf; `naechstesStueck` rechnet, wie
 * viel als Nächstes zu holen ist.
 */

/** Wie viele Dateien ein Paket höchstens trägt (die Hülle nimmt nie mehr). */
export const FREIGABE_MAX_DATEIEN = 10;

/** Rohdaten je Aufruf von `leseDatei` — gleich der Obergrenze der Hülle
 *  (`ShareReceiverPlugin.stueckBytes`). */
export const STUECK_BYTES = 384 * 1024;

export type GeteilteDatei = {
  id: string;
  name: string;
  mime: string;
  groesse: number;
};

export type GeteilterInhalt = {
  text: string | null;
  bild: { base64: string; mime: string } | null;
  dateien: GeteilteDatei[];
  paketId: string | null;
  uebersprungen: number;
};

/** Die Dateiliste der Hülle, bereinigt: nur vollständige Einträge, höchstens
 *  `FREIGABE_MAX_DATEIEN`, keine leeren Dateien (die der Server ablehnte). */
export function normalisiereDateien(roh: unknown): GeteilteDatei[] {
  if (!Array.isArray(roh)) return [];
  const ergebnis: GeteilteDatei[] = [];
  for (const e of roh) {
    if (ergebnis.length >= FREIGABE_MAX_DATEIEN) break;
    if (!e || typeof e !== 'object') continue;
    const { id, name, mime, groesse } = e as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') continue;
    if (typeof groesse !== 'number' || !Number.isFinite(groesse) || groesse <= 0) continue;
    ergebnis.push({
      id,
      name: typeof name === 'string' ? name : '',
      mime: typeof mime === 'string' && mime !== '' ? mime : 'application/octet-stream',
      groesse: Math.floor(groesse)
    });
  }
  return ergebnis;
}

/** Die Paket-Kennung der Hülle, wie sie roh in der Antwort steht — auch dann,
 *  wenn `inhaltAusAntwort` kein Paket daraus macht (nur ungültige Einträge):
 *  die Hülle hält die Dateien trotzdem im Container und muss es erfahren
 *  (`abschliessen`), sonst bleiben sie bis zur 24-Stunden-Aufräumung liegen. */
export function paketIdAusAntwort(roh: unknown): string | null {
  const id = roh && typeof roh === 'object' ? (roh as Record<string, unknown>).paketId : null;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Macht aus der Antwort von `ShareReceiver.getPending()` den Inhalt — für
 * BEIDE Fassungen der Hülle: die neue (`dateien` + `paketId`) und die alte
 * bzw. Android (`imageBase64`). `null`, wenn nichts Brauchbares darin steht.
 */
export function inhaltAusAntwort(roh: unknown): GeteilterInhalt | null {
  if (!roh || typeof roh !== 'object') return null;
  const p = roh as Record<string, unknown>;
  const text = typeof p.text === 'string' && p.text !== '' ? p.text : null;
  const bild =
    typeof p.imageBase64 === 'string' && p.imageBase64 !== ''
      ? { base64: p.imageBase64, mime: typeof p.imageMime === 'string' ? p.imageMime : 'image/jpeg' }
      : null;
  const paketId = typeof p.paketId === 'string' && p.paketId !== '' ? p.paketId : null;
  const dateien = paketId ? normalisiereDateien(p.dateien) : [];
  const uebersprungen =
    typeof p.uebersprungen === 'number' && p.uebersprungen > 0 ? Math.floor(p.uebersprungen) : 0;
  if (!text && !bild && dateien.length === 0) return null;
  return { text, bild, dateien, paketId: dateien.length ? paketId : null, uebersprungen };
}

/** Wie viele Bytes als Nächstes zu holen sind; `0`, wenn die Datei komplett ist. */
export function naechstesStueck(offset: number, groesse: number, stueck = STUECK_BYTES): number {
  if (offset < 0 || offset >= groesse) return 0;
  return Math.min(stueck, groesse - offset);
}

/** Ein Dateiname für den Anhang: der gelieferte, sonst „geteilt N“ mit einer
 *  Endung aus dem Typ. */
export function dateiName(name: string, mime: string, nummer: number): string {
  const sauber = name.trim();
  if (sauber !== '') return sauber;
  const endung = mime.split('/')[1]?.split(/[+;]/)[0];
  return `geteilt ${nummer}` + (endung && endung !== 'octet-stream' ? `.${endung}` : '');
}

/** Base64 (ohne Zeilenumbrüche) zu Bytes. */
export function base64ZuBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binaer = atob(base64);
  const bytes = new Uint8Array(binaer.length);
  for (let i = 0; i < binaer.length; i++) bytes[i] = binaer.charCodeAt(i);
  return bytes;
}
