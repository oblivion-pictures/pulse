<!--
  TwitchChatPanel — nur-lesende Ansicht des Live-Chats eines Twitch-Kanals.
  Inhaltbereich des Watch-Party-Chats (Reiter „Twitch“): keine eigene Hülle
  oder Kopfzeile, die liefert WatchChatPanel mit. Verbindung läuft genau so
  lange wie dieser Reiter gemountet ist (acquire im Effekt-Cleanup).
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { twitchChat } from '$lib/stores/twitchChat.svelte';
  import { anzeigeFarbe } from '$lib/watch/twitchIrc';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import LockIcon from '@lucide/svelte/icons/lock';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';

  let { channel }: { channel: string } = $props();

  const messages = $derived(twitchChat.for(channel));
  const status = $derived(twitchChat.statusOf(channel));

  let listEl = $state<HTMLDivElement | null>(null);
  // Auto-Scroll nur, wenn der User unten klebt — sonst Highscroll-Schutz wie
  // im Pulse-Party-Chat (gleiche 80-px-Schwelle). `seen` zählt, wie viele
  // Nachrichten beim letzten Blick von unten gesehen wurden.
  let stickToBottom = $state(true);
  let seen = 0;

  function onScroll(): void {
    if (!listEl) return;
    stickToBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
    if (stickToBottom) seen = messages.length;
  }

  const newCount = $derived(stickToBottom ? 0 : Math.max(0, messages.length - seen));

  function resume(): void {
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  }

  // Verbindung lebt so lange wie der Reiter; Kanalwechsel = alte Verbindung
  // freigeben (Effekt-Cleanup), neue anfordern.
  $effect(() => {
    const ch = channel;
    return twitchChat.acquire(ch);
  });

  $effect(() => {
    if (messages.length === 0 || !stickToBottom) return;
    void tick().then(() => {
      if (listEl && stickToBottom) listEl.scrollTop = listEl.scrollHeight;
    });
  });

  onMount(() => {
    void tick().then(() => {
      if (listEl) listEl.scrollTop = listEl.scrollHeight;
    });
  });
</script>

<div class="flex h-full min-h-0 w-full flex-col" data-testid="twitch-chat-panel">
  {#if status === 'connecting' || status === 'reconnecting'}
    <div
      class="px-3 pt-2 text-2xs {status === 'reconnecting' ? 'text-amber-400' : 'text-text-muted'}"
      data-testid="twitch-chat-status"
    >
      {#if status === 'reconnecting'}
        {m.twitch_chat_status_reconnecting()}
      {:else}
        {m.twitch_chat_status_connecting({ channel })}
      {/if}
    </div>
  {/if}

  <div class="relative min-h-0 flex-1">
    <div
      bind:this={listEl}
      onscroll={onScroll}
      class="h-full overflow-y-auto px-3 py-2"
      data-testid="twitch-chat-messages"
    >
      {#if messages.length === 0}
        <EmptyState density="page" message={m.twitch_chat_empty()} />
      {:else}
        <ul class="flex flex-col gap-1">
          {#each messages as msg (msg.id)}
            <li class="text-sm leading-snug" data-testid="twitch-chat-message">
              <p class="text-text-bright break-words {msg.action ? 'italic' : ''}">
                <span class="font-semibold" style="color:{anzeigeFarbe(msg.color, msg.login)}"
                  >{msg.displayName}</span
                >{#if !msg.action}<span class="text-text-muted">:</span>{/if}
                {#each msg.parts as part, i (i)}
                  {#if part.kind === 'emote'}
                    <img
                      src="https://static-cdn.jtvnw.net/emoticons/v2/{part.id}/default/dark/1.0"
                      alt={part.name}
                      title={part.name}
                      class="mx-0.5 inline h-6 align-[-0.3rem]"
                      loading="lazy"
                    />
                  {:else}{part.text}{/if}
                {/each}
              </p>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    {#if newCount > 0}
      <button
        type="button"
        onclick={resume}
        class="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-bg-panel px-3 py-1.5 text-xs font-medium text-text-bright shadow-lg ring-1 ring-border"
        data-testid="twitch-chat-resume"
      >
        <ArrowDownIcon class="size-3.5" />
        {m.twitch_chat_new_messages({ count: newCount })}
      </button>
    {/if}
  </div>

  <footer
    class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-3 py-2 text-xs text-text-muted"
    data-testid="twitch-chat-footer"
  >
    <LockIcon class="size-3.5 shrink-0" />
    <span class="min-w-0 truncate">{m.twitch_chat_readonly_hint()}</span>
    <a
      href="https://www.twitch.tv/{channel}"
      target="_blank"
      rel="noopener noreferrer"
      class="ml-auto flex shrink-0 items-center gap-1 text-primary hover:underline"
      data-testid="twitch-chat-open"
    >
      {m.twitch_chat_open_twitch()}
      <ExternalLinkIcon class="size-3.5" />
    </a>
  </footer>
</div>
