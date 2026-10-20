/**
 * Gehört eine zugestellte System-Meldung zu einer dieser Unterhaltungen? Die
 * reine Regel zu `zugestellteMeldungen.ts`, importfrei für Nodes Testläufer
 * (`pnpm test:unit`-Falle).
 *
 * Zwei Merkmale, weil die Plattformen verschieden viel zurückgeben
 * (`@capacitor-firebase/messaging`, `getDeliveredNotifications`):
 *
 * - **Android** liefert die Datenfelder der Meldung NICHT mit, wohl aber ihren
 *   `tag`. Der Server setzt `tag = channel_id`; eine Meldung derselben
 *   Unterhaltung ersetzt damit auch die vorige, statt sich zu stapeln.
 * - **iOS** kennt kein `tag`, liefert aber die Nutzlast (`data`) mit, und die
 *   trägt `channel_id` — dieselbe, nach der ein Tipp navigiert
 *   (`mitteilungsZiel.ts`). Die `thread-id`, die der Server dort setzt, gibt
 *   das Plugin nicht heraus.
 */

export interface ZugestellteMeldung {
  tag?: string;
  data?: unknown;
}

function kanalAusDaten(daten: unknown): string | null {
  if (typeof daten !== 'object' || daten === null) return null;
  const wert = (daten as Record<string, unknown>).channel_id;
  if (typeof wert === 'string' && wert) return wert;
  return typeof wert === 'number' ? String(wert) : null;
}

export function meldungGehoertZu(
  meldung: ZugestellteMeldung,
  kanaele: ReadonlySet<string>
): boolean {
  if (meldung.tag && kanaele.has(meldung.tag)) return true;
  const kanal = kanalAusDaten(meldung.data);
  return kanal !== null && kanaele.has(kanal);
}
