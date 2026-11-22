<!--
  WatchChatTabs — Reiter-Umschaltung im Watch-Party-Chat zwischen dem eigenen
  Pulse-Chat und dem (nur lesbaren) Twitch-Live-Chat. Erscheint nur, wenn die
  Party-Quelle ein Twitch-Live-Kanal ist; die Entscheidung trifft
  WatchChatPanel, das auch den Inhalt unterhalb austauscht.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';

  let {
    active,
    onSelect
  }: {
    active: 'pulse' | 'twitch';
    onSelect: (tab: 'pulse' | 'twitch') => void;
  } = $props();
</script>

<div
  class="flex gap-1 border-b border-border px-2 py-1.5"
  role="tablist"
  data-testid="watch-chat-tabs"
>
  <button
    type="button"
    role="tab"
    aria-selected={active === 'pulse'}
    onclick={() => onSelect('pulse')}
    class="rounded-full px-3 py-1 text-xs font-medium transition-colors handy:py-2.5 {active ===
    'pulse'
      ? 'bg-bg-hover text-text-bright'
      : 'text-text-muted hover:bg-bg-hover/60 hover:text-text-base'}"
    data-testid="watch-chat-tab-pulse"
  >
    {m.watch_chat_tab_pulse()}
  </button>
  <button
    type="button"
    role="tab"
    aria-selected={active === 'twitch'}
    onclick={() => onSelect('twitch')}
    class="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors handy:py-2.5 {active ===
    'twitch'
      ? 'bg-bg-hover text-text-bright'
      : 'text-text-muted hover:bg-bg-hover/60 hover:text-text-base'}"
    data-testid="watch-chat-tab-twitch"
  >
    <!-- Twitch hat bei Lucide kein Marken-Symbol mehr — der lila Punkt als
         schlichter Farbanker. -->
    <span class="size-2 shrink-0 rounded-full bg-[#9146FF]"></span>
    {m.watch_chat_tab_twitch()}
  </button>
</div>
