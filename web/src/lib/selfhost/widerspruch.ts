/**
 * Was eine Antwort der Cloud auf „Widersprechen“ bedeutet
 * (`POST /me/instances/{id}/uebernahme/widerspruch`, Widerspruchsfrist, Spec
 * 2026-10-09 Nachtrag 2026-10-11) — reine Rechnung, importfrei (Node-Unit-Test,
 * s. `pnpm test:unit`-Falle in CLAUDE.md). Muster: `verbinden/fehler.ts`.
 *
 * Quelle der Codes: die Route in auth-svc. 204 ist der Erfolg und kommt hier
 * nicht vor; die Texte stehen im Paraglide-Katalog unter
 * `meine_server_uebernahme_fehler_*`.
 */

export const WIDERSPRUCH_FEHLER = [
  /** 409 `widerspruch_ohne_server`: unter der Adresse antwortet nicht (mehr)
   *  dieser Server. Wer widerspricht, muss seinen Server dort noch betreiben —
   *  sonst wehrte der Widerspruch auch den echten Domaininhaber ab. */
  'ohne_server',
  /** 404: kein eigener Eintrag oder kein lebendiger Antrag (mehr) — abgelaufen,
   *  vollzogen oder schon widersprochen. */
  'nicht_mehr',
  /** 503 `verbinden_ausgelastet`: die Cloud prüft gerade zu viele Server. */
  'ausgelastet',
  'gebremst',
  'abgemeldet',
  'sonst'
] as const;

export type WiderspruchFehler = (typeof WIDERSPRUCH_FEHLER)[number];

function detail(body: unknown): unknown {
  return body !== null && typeof body === 'object' && 'detail' in body
    ? (body as { detail: unknown }).detail
    : undefined;
}

/** `status` = HTTP-Status der Antwort, `null` = gar keine Antwort (Netz weg). */
export function widerspruchFehler(status: number | null, body: unknown): WiderspruchFehler {
  const d = detail(body);
  if (status === 404) return 'nicht_mehr';
  if (status === 401) return 'abgemeldet';
  if (status === 429) return 'gebremst';
  if (status === 503 && d === 'verbinden_ausgelastet') return 'ausgelastet';
  if (status === 409 && d !== null && typeof d === 'object') {
    if ((d as { code?: unknown }).code === 'widerspruch_ohne_server') return 'ohne_server';
  }
  return 'sonst';
}

/** Paraglide-Schlüssel des Hinweistextes. */
export function widerspruchSchluessel(art: WiderspruchFehler): string {
  return `meine_server_uebernahme_fehler_${art}`;
}
