<!--
  HqStreamBackgroundHost — siblings `WatchBackgroundHost` and `LiveKitBackgroundHost`.
  Lives once in the app layout and renders a `WhepPlayer` per open HQ stream
  (sourced from `openedTiles`), positioned over the StreamGrid anchor (docked)
  or as a corner window when no anchor exists.

  The inline tile was removed from StreamGrid (it's now an empty anchor div);
  this is the only mount point of `WhepPlayer`. That's how the stream keeps
  running when you navigate to a text channel / DM — `HqStreamKeepAlive`
  keeps the WHEP connection alive in parallel.

  Läuft der Stream im eigenen Player-Fenster (`hqStreamBackground.imFenster`),
  bleibt der `WhepPlayer` hier gemountet, aber unsichtbar: er hält die
  Fenster-Sitzung, und das Raster gibt ihm absichtlich keinen Anker mehr. Ohne
  diesen Zweig sprang er als Eckfenster mit leerem Inhalt auf.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { fensterChat } from '$lib/player/fensterChat.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { hqStreamBackground } from '$lib/stream/hqStreamBackground.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { parseHqTileId } from '$lib/stream/hqTile';
  import { userCache } from '$lib/stores/users.svelte';
  import { voiceState } from '$lib/voice/state.svelte';
  import WatchBackgroundFrame from '$lib/watch/WatchBackgroundFrame.svelte';
  import WhepPlayer from './WhepPlayer.svelte';

  // Handy-Klasse? Reicht die app-layout-Route hereingereicht an die Kacheln
  // durch (Geräte-Trennung — der Host fragt selbst nicht).
  let { handy }: { handy: boolean } = $props();

  // Every open, non-detached HQ stream-tile whose (user, slot) is currently
  // live (otherwise the tile would sit as an error placeholder when the
  // streamer goes offline). Source is `openedTiles` (opened via sidebar /
  // voice-tile badges); `HqStreamKeepAlive` uses the same list to keep
  // connections alive. The tile id is `<userId>:<slot>`.
  //
  // Der eigene Stream ist bewusst NICHT ausgeschlossen: klickt man seinen
  // eigenen LIVE-Badge, wird er über `openedTiles` geöffnet und hier gerendert
  // (die eigene WHEP-Vorschau). Ohne Klick erscheint er nicht — auto-open in
  // VoiceChannelView überspringt den eigenen Nutzer.
  //
  // `index` stapelt die Eckfenster; ein unsichtbarer Fenster-Strom nimmt
  // keinen Stapelplatz, sonst klaffte im Eck eine Lücke.
  let shown = $derived.by(() => {
    let sichtbar = 0;
    return openedTiles
      .entriesOfKind('hq')
      .map((e) => ({ tileId: e.id, channelId: e.channelId, ...parseHqTileId(e.id) }))
      .filter(
        (e) =>
          !detachedStreams.has(e.channelId, e.userId, e.slot) &&
          streamPresence
            .streamsIn(e.channelId)
            .some((s) => s.user_id === e.userId && s.slot === e.slot)
      )
      .map((e) => {
        const imFenster = hqStreamBackground.imFenster(e.channelId, e.tileId);
        return { ...e, imFenster, index: imFenster ? 0 : sichtbar++ };
      });
  });

  // "Name" for a tile — suffixed " (1)" / " (2)" only when the user runs more
  // than one stream, so a single stream just shows the plain name.
  function tileName(channelId: string, userId: string, slot: number): string {
    const base = userCache.displayName(userId);
    const multi =
      streamPresence.streamsIn(channelId).filter((s) => s.user_id === userId).length > 1;
    return multi ? `${base} (${slot + 1})` : base;
  }

  // Close HQ tiles that lose their reason to stay when the connected voice
  // channel changes / drops — same rationale as WatchBackgroundHost: the
  // anchor's destroy in StreamGrid only fires on a real unmount, so a
  // corner-mode tile that survived a "navigate-away-then-hang-up" sequence
  // would otherwise sit as a ghost popup. Viewed tiles (anchor present) stay
  // open.
  let prevVoice: string | null = null;
  $effect(() => {
    const cur = voiceState.connected ? voiceState.channelId : null;
    const prev = prevVoice;
    prevVoice = cur;
    if (!prev || prev === cur) return;
    for (const e of openedTiles.entriesOfKind('hq')) {
      if (
        e.channelId === prev &&
        hqStreamBackground.anchorRect(e.channelId, e.id) === null
      ) {
        openedTiles.close('hq', e.channelId, e.id);
      }
    }
  });

  function returnTo(channelId: string): void {
    const guildId = guilds.guildIdForChannel(channelId);
    if (guildId) goto(`/app/guilds/${guildId}/channels/${channelId}`);
  }

  // „Chat öffnen“ im Player-Fenster eines Fenster-Stroms: der Chat geht als
  // Seitenleiste im Sprachkanal auf (`StreamFensterChat`). Der Hauptprozess
  // holt die App nach vorne — steht sie gerade woanders (Textkanal, DM), käme
  // die Seitenleiste dort nie in Sicht, also führt der Wunsch in den Kanal.
  // Hier und nicht im `WhepPlayer`: dieser Host lebt wie die Sitzungen
  // unabhängig von der Navigation.
  $effect(() => {
    const w = fensterChat.wunsch;
    if (!w) return;
    untrack(() => {
      if (page.params.channelId !== w.channelId) returnTo(w.channelId);
    });
  });
  // Ist das letzte Fenster des Streamers zu, verfällt der Wunsch (Begründung
  // bei `fensterChat.aufraeumen`).
  $effect(() => fensterChat.aufraeumen());
</script>

{#each shown as e (e.channelId + '::' + e.tileId)}
  {@const rect = hqStreamBackground.anchorRect(e.channelId, e.tileId)}
  <!-- Ausblenden über die Klasse, NICHT über ein `{#if}`: ein Zweig hängte den
       `WhepPlayer` beim Wechsel ins Fenster aus und wieder ein. Das kostete
       seinen Zustand (u. a. den Zähler der Chat-Wünsche — der frisch
       gemountete sähe jeden alten Wunsch als neuen) und bei jedem Wechsel
       eine Runde durch die Sitzungs-Registry. `contents` lässt das feste
       Rahmen-Element darunter unverändert wirken. -->
  <div class={e.imFenster ? 'hidden' : 'contents'} data-testid="hq-bg-slot" data-im-fenster={e.imFenster}>
    <WatchBackgroundFrame {rect} index={e.index} onReturn={() => returnTo(e.channelId)}
        onClose={() => openedTiles.close('hq', e.channelId, e.tileId)}>
      <WhepPlayer
        channelId={e.channelId}
        userId={e.userId}
        {handy}
        streamSlot={e.slot}
        name={tileName(e.channelId, e.userId, e.slot)}
        canDetach={true}
        canHide={true}
      />
    </WatchBackgroundFrame>
  </div>
{/each}