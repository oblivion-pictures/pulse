/**
 * Zeilen des Rail-Tooltips (`GuildVoiceTooltip.svelte`) — die reine Rechnung,
 * herausgezogen, damit sie einen Test bekommen kann (Svelte-Dateien und
 * `.svelte.ts` erreicht der Node-Läufer nicht; Muster
 * `lib/nachrichten/klebezustand.ts`). Ohne Laufzeit-Importe, nur Typen.
 */

export type VoiceChannelRow = {
  id: string;
  name: string;
  userIds: string[];
  /** LIVE = Screen-Share ∪ HQ-Stream (gleiche Union wie `VoiceChannelMembers`). */
  streamingUserIds: string[];
  /** User mit Webcam an (server-seitig via LiveKit-Webhook gepflegt). */
  camUserIds: string[];
  /** Watch-Party-Hosts in diesem Channel (mehrere Parties möglich). */
  partyHostUserIds: string[];
  /** Gast-Kennung (`gast-<id>`) → getippter Name. **Je Zeile, nicht aus
   *  `voicePresence`**: der Store bildet nur den AKTIVEN Server ab, für einen
   *  fremden Server stünde dort nichts, und der Gast erschiene mit seiner
   *  Kennung (Befund 2026-10-20). */
  gastNamen: Record<string, string>;
};

/** Sprachkanal (`Channel.type`). */
const SPRACHKANAL = 1;

type Kanal = { id: string; name: string; type: number };
type Sprachstand = {
  channel_id: string;
  user_ids: string[];
  streaming_user_ids: string[];
  camera_user_ids: string[];
  gast_namen?: Record<string, string>;
};
type Streamstand = { channel_id: string; user_ids: string[] };
type Watchstand = { channel_id: string; state: { host_user_id: string } };

/** Zeilen eines NICHT aktiven Servers aus seinen vier REST-Antworten
 *  (`listChannels`, `guildVoiceState`, `guildStreamState`, `guildWatchState`).
 *  Nur belegte Sprachkanäle. */
export function fremdeZeilen(
  kanaele: Kanal[],
  sprache: Sprachstand[],
  streams: Streamstand[],
  watch: Watchstand[]
): VoiceChannelRow[] {
  const voiceByCh = new Map(sprache.map((s) => [s.channel_id, s]));
  const hqByCh = new Map(streams.map((s) => [s.channel_id, s.user_ids]));
  const partyHostsByCh = new Map<string, string[]>();
  for (const w of watch) {
    const arr = partyHostsByCh.get(w.channel_id) ?? [];
    arr.push(w.state.host_user_id);
    partyHostsByCh.set(w.channel_id, arr);
  }
  const rows: VoiceChannelRow[] = [];
  for (const c of kanaele) {
    if (c.type !== SPRACHKANAL) continue;
    const v = voiceByCh.get(c.id);
    const userIds = v?.user_ids ?? [];
    if (userIds.length === 0) continue;
    rows.push({
      id: c.id,
      name: c.name,
      userIds,
      streamingUserIds: [
        ...new Set([...(v?.streaming_user_ids ?? []), ...(hqByCh.get(c.id) ?? [])])
      ],
      camUserIds: v?.camera_user_ids ?? [],
      partyHostUserIds: partyHostsByCh.get(c.id) ?? [],
      gastNamen: v?.gast_namen ?? {}
    });
  }
  return rows;
}

/** Name eines Gastes in dieser Zeile — oder die Kennung als Rückfall. Ein
 *  fehlender Name ist ein Schönheitsfehler, kein Grund, den Gast zu
 *  verschweigen (gleiche Haltung wie `voicePresence.gastName`). */
export function gastName(zeile: VoiceChannelRow, id: string): string {
  return zeile.gastNamen[id] ?? id;
}
