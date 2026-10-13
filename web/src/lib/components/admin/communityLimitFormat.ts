/**
 * Zahlen-Formatierung für den Betreiber-Grenzen-Editor.
 *
 * Das Formular hält alles als String ('' = nicht gesetzt / erben). Backend
 * spricht kbit/s und Bytes, die Oberfläche zeigt Mbit/s und MB/GB. Reine
 * Utility, aus `AdminCommunityLimits.svelte` ausgelagert, damit die Komponente
 * unter der Größen-Grenze bleibt.
 */

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

/** '' / null → null, sonst die endliche Zahl (oder null bei Müll). */
export function numOrNull(s: unknown): number | null {
  if (s === '' || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const kbpsToMbpsStr = (v: number | null): string => (v == null ? '' : String(v / 1000));

export function mbpsStrToKbps(s: unknown): number | null {
  const mbps = numOrNull(s);
  return mbps == null ? null : Math.round(mbps * 1000);
}

/** Bytes → Anzeige-Einheit als Zahl (für die Platzhalter der Datei-Obergrenzen). */
export const bytesToUnit = (v: number, unit: number): number =>
  Math.round((v / unit) * 100) / 100;

export const bytesToUnitStr = (v: number | null, unit: number): string =>
  v == null ? '' : String(bytesToUnit(v, unit));

export function unitStrToBytes(s: unknown, unit: number): number | null {
  const n = numOrNull(s);
  return n == null ? null : Math.round(n * unit);
}

/** Wie `unitStrToBytes`, aber ein UNVERÄNDERTES Feld liefert den gespeicherten
 *  Wert zurück statt der Rückrechnung seiner gerundeten Anzeige.
 *
 *  Das Betreiber-Formular schickt immer den vollen Satz (NULL löscht dort eine
 *  Übersteuerung), kann ein unverändertes Feld also nicht weglassen. Es kann
 *  aber den Wert schicken, den der Server schon hat: `bytesToUnitStr` rundet auf
 *  zwei Stellen, und 1.000.000 Byte würden sonst über „0.95" zu 996.147.
 *  `stored` ist der aktuelle Stand des Servers (die Prop der Community), nicht
 *  der beim Öffnen gemerkte — sonst verlöre ein Zurücktippen auf den alten Wert
 *  nach einem Speichern seine Wirkung. */
export function unitStrToBytesKeep(
  shown: unknown,
  stored: number | null,
  unit: number
): number | null {
  const text = shown == null ? '' : String(shown);
  if (text === bytesToUnitStr(stored, unit)) return stored;
  return unitStrToBytes(shown, unit);
}

/** Instanz-Standards der zwei Datei-Obergrenzen — Spiegel von
 *  ``DEFAULT_ATTACHMENT_MAX_SIZE_BYTES`` / ``DEFAULT_ATTACHMENT_MAX_COUNT``
 *  (guild_limits.py). Synchron halten. */
export const DEFAULT_ATTACH_MAX_SIZE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ATTACH_MAX_COUNT = 4;

/** Die Obergrenze, die tatsächlich gilt: die des Betreibers, sonst der
 *  Instanz-Standard. Der Server liefert für „nicht gesetzt" `null` — als Zahl
 *  gelesen wäre das 0 („Aktuell: 0") und sagte das Gegenteil. */
export function ceilingOrDefault(v: number | null | undefined, standard: number): number {
  return v ?? standard;
}
