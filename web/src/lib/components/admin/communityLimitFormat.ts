/**
 * Zahlen-Formatierung für den Betreiber-Grenzen-Editor.
 *
 * Das Formular hält alles als String ('' = nicht gesetzt / erben). Backend
 * spricht kbit/s und Bytes, die Oberfläche zeigt Mbit/s und MB/GB. Reine
 * Utility, aus `AdminCommunityLimits.svelte` ausgelagert, damit die Komponente
 * unter der Größen-Grenze bleibt.
 */

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

/** Bytes → Anzeige-Einheit als Zahl (für die Platzhalter der Pflichtfelder). */
export const bytesToUnit = (v: number, unit: number): number =>
  Math.round((v / unit) * 100) / 100;

export const bytesToUnitStr = (v: number | null, unit: number): string =>
  v == null ? '' : String(bytesToUnit(v, unit));

export function unitStrToBytes(s: unknown, unit: number): number | null {
  const n = numOrNull(s);
  return n == null ? null : Math.round(n * unit);
}

/** Instanz-Standards der zwei Datei-Obergrenzen — Spiegel von
 *  ``DEFAULT_ATTACHMENT_MAX_SIZE_BYTES`` / ``DEFAULT_ATTACHMENT_MAX_COUNT``
 *  (guild_limits.py). Synchron halten. */
export const DEFAULT_ATTACH_MAX_SIZE_BYTES = 26214400;
export const DEFAULT_ATTACH_MAX_COUNT = 4;

/** Die Obergrenze, die tatsächlich gilt: die des Betreibers, sonst der
 *  Instanz-Standard. Der Server liefert für „nicht gesetzt" `null` — als Zahl
 *  gelesen wäre das 0 („Aktuell: 0") und sagte das Gegenteil. */
export const ceilingOrDefault = (v: number | null | undefined, standard: number): number =>
  v ?? standard;
