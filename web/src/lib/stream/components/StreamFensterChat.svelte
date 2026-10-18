<!--
  StreamFensterChat — der Stream-Chat als Seitenleiste rechts im Sprachkanal,
  für einen Stream, der im eigenen Player-Fenster läuft.

  Dessen Kachel steht seit 2026-10-19 nicht mehr im Raster, also auch nicht ihr
  Chat (`TileShell` → `chatPanel`). „Chat öffnen“ im Fenster legt den Wunsch
  in `fensterChat` ab; diese Leiste zeigt ihn, solange ein Fenster des
  Streamers läuft, und das X nimmt ihn zurück. Nur am Rechner eingehängt
  (`VoiceChannelView`, wie die Mitgliederliste).
-->
<script lang="ts">
  import StreamChatPanel from './StreamChatPanel.svelte';
  import { fensterChat } from '$lib/player/fensterChat.svelte';

  let { channelId }: { channelId: string } = $props();

  let streamerId = $derived(fensterChat.streamerIn(channelId));
</script>

{#if streamerId}
  <div class="flex h-full shrink-0" data-testid="voice-stream-chat-panel">
    <StreamChatPanel {channelId} {streamerId} onClose={() => fensterChat.schliessen()} />
  </div>
{/if}
