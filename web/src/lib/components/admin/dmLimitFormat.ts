/**
 * Rechnung des DM-Dateigrößen-Feldes (Betreiber-Einstellungen, `AdminAttachments`).
 *
 * Importfrei, damit `pnpm test:unit` sie ohne Bundler prüfen kann (s. CLAUDE.md,
 * zwei Fallen). Zwei Dinge liegen hier, weil sie zusammengehören:
 *
 *  - **Anzeige**: Bytes → MiB, ohne auf ganze Zahlen zu runden. Vorher hieß es
 *    `Math.round(bytes / 1024 / 1024)`: ein gespeicherter Wert von 0,5 MiB
 *    erschien als 1 (und 1,5 als 2).
 *  - **Speichern**: nur senden, was der Betreiber wirklich geändert hat. Die
 *    Anzeige ist gerundet, der gespeicherte Wert ist es nicht — ginge das Feld
 *    bei jedem Speichern mit, schriebe das Ändern der Dateizahl den
 *    gerundeten Anzeigewert als neue Größe zurück (genau so wurde aus 0,5 still
 *    1 MiB, ohne dass jemand an der Größe etwas angefasst hätte).
 */

const MIB = 1024 * 1024;

/** Kleinster Wert, den der Server annimmt (`ChatSettingsPatch`: ge=1024). */
export const DM_MIN_BYTES = 1024;

/** Bytes → MiB für die Anzeige, auf vier Nachkommastellen: genug, damit ein
 *  eingetippter Wert wie 0,3 nach dem Rundlauf wieder 0,3 zeigt (und nicht
 *  0,29999923706054688), und fein genug für die 1-KiB-Untergrenze (0,001). */
export const bytesToMiB = (bytes: number): number =>
  Math.round((bytes / MIB) * 10_000) / 10_000;

/** Was das Größenfeld beim Speichern schicken soll, oder `undefined` = Feld
 *  weglassen. Weggelassen wird, wenn das Feld leer/unlesbar ist oder noch
 *  genau den Anzeigewert des gespeicherten Standes zeigt. */
export function dmSizeToSave(shown: unknown, storedBytes: number): number | undefined {
  if (shown === '' || shown == null) return undefined;
  const mib = Number(shown);
  if (!Number.isFinite(mib)) return undefined;
  if (mib === bytesToMiB(storedBytes)) return undefined;
  return Math.max(DM_MIN_BYTES, Math.round(mib * MIB));
}
