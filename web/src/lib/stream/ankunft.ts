/**
 * Ist der eigene Stream beim Server angekommen? Die reine Rechnung hinter
 * `ankunftWache.ts`.
 *
 * **Importfrei**, damit `pnpm test:unit` sie laden kann (s. die
 * `pnpm test:unit`-Falle in `CLAUDE.md`). Die Wache mit Uhren, REST-Ruf und
 * Toast liegt daneben.
 *
 * Gelesen wird die Antwort von `GET /guilds/{id}/stream-state`. Ihre Form
 * (`dcc_chat_gateway/pubsub.py::_parse_stream_state`): `user_ids` je Kanal,
 * dazu `streams` mit Platz-Angaben NUR, wenn jemand auf Platz 1 oder höher
 * sendet. Fehlt `streams`, stehen die `user_ids` für Platz 0 — dieselbe Regel
 * wie `streamPresence.streamsIn`.
 */

export type StreamStand = {
  channel_id: string;
  user_ids: string[];
  streams?: { user_id: string; slot?: number }[];
};

export function istAngekommen(
  staende: StreamStand[],
  kanalId: string,
  nutzerId: string,
  platz: number,
): boolean {
  const stand = staende.find((s) => String(s.channel_id) === kanalId);
  if (!stand) return false;
  if (stand.streams?.length) {
    return stand.streams.some(
      (s) => String(s.user_id) === nutzerId && Number(s.slot ?? 0) === platz,
    );
  }
  return (
    platz === 0 && (stand.user_ids ?? []).some((u) => String(u) === nutzerId)
  );
}
