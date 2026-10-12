/**
 * Umrechnung zwischen dem Wire-Wert eines Limits und seiner Anzeige.
 *
 * Backend speichert kbit/s und Bytes; die Oberfläche zeigt Mbit/s und MB/GB,
 * weil das die Zahlen sind, die ein Mensch eintippt. Beide Richtungen an einer
 * Stelle, damit Editor und Platzhalter nie auseinanderlaufen.
 */

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

export type LimitKind = 'raw' | 'mbps' | 'mb' | 'gb' | 'resolution';

/** Von hoch nach niedrig; 'Native' = ungedeckelt. Deckt sich mit
 *  ``RESOLUTION_LADDER`` im Backend (``guild_limits.py``). */
export const RESOLUTION_LADDER = ['Native', '4K', '1440p', '1080p', '720p', '480p'];

/** Wire-Wert → Anzeige-String ('' wenn nichts gesetzt). */
export function toDisplay(wire: number | string | null, kind: LimitKind): string {
  if (wire == null) return '';
  if (kind === 'resolution') return String(wire);
  const n = Number(wire);
  if (kind === 'mbps') return String(n / 1000);
  if (kind === 'mb') return String(Math.round((n / MB) * 100) / 100);
  if (kind === 'gb') return String(Math.round((n / GB) * 100) / 100);
  return String(n);
}

/** Anzeige-Wert → Wire (null wenn leer/ungültig). */
export function toWire(display: unknown, kind: LimitKind): number | string | null {
  if (kind === 'resolution') return display ? String(display) : null;
  if (display === '' || display == null) return null;
  const n = Number(display);
  if (!Number.isFinite(n)) return null;
  if (kind === 'mbps') return Math.round(n * 1000);
  if (kind === 'mb') return Math.round(n * MB);
  if (kind === 'gb') return Math.round(n * GB);
  return Math.round(n);
}

/** Ein Feld des Community-Grenzen-Editors, soweit die Payload-Rechnung es
 *  braucht. `required`: die Spalte dahinter ist NOT NULL (Dateigröße,
 *  Dateizahl) — Spiegel von `value_nullable=False` in `guild_limits.py`.
 *  Synchron halten. */
export type LimitFieldSpec = { key: string; kind: LimitKind; required?: boolean };

/**
 * Was `PATCH /guilds/{id}/limits` bekommt: **nur die Felder, die der Nutzer
 * angefasst hat.** Der Server lässt nicht genannte Limits unberührt.
 *
 * Warum nicht den vollen Satz wie früher: die Anzeige ist gerundet
 * (`toDisplay`: zwei Nachkommastellen), der gespeicherte Wert nicht. Ein
 * Formular, das bei jedem Speichern alles zurückschickt, ersetzt deshalb jeden
 * Wert, der nicht glatt aufgeht (1.000.000 Byte werden als 0,95 MB gezeigt,
 * 0,95 MB sind 996.147 Byte), durch den gerundeten — auch wenn nur ein ganz
 * anderes Feld geändert wurde.
 *
 * „Angefasst" heißt: das Feld zeigt etwas anderes als die Anzeige des
 * gespeicherten Wertes (`stored`, Wire-Werte). Ein geleertes Pflichtfeld wird
 * ausgelassen — leer heißt dort „nicht ändern", ein `null` wäre für den Server
 * ein 422 (die Spalte kann nicht geleert werden). Ein geleertes optionales
 * Feld schickt `null` und holt damit die Vorgabe des Betreibers zurück.
 */
export function changedLimitsPayload(
  fields: LimitFieldSpec[],
  inputs: Record<string, string>,
  stored: Record<string, number | string | null>
): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  for (const f of fields) {
    const shown = inputs[f.key] ?? '';
    if (shown === toDisplay(stored[f.key] ?? null, f.kind)) continue;
    const wire = toWire(shown, f.kind);
    if (wire === null && f.required) continue;
    out[f.key] = wire;
  }
  return out;
}
