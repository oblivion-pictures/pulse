<script lang="ts">
  /**
   * Eine Direktnachricht in der Chats-Liste des Handys — herausgelöst aus
   * `MobileChatsList.svelte`, damit die Zeile ihren ⋯-Knopf tragen kann, ohne
   * die Liste über die Grenze für Svelte-Komponenten (250 Zeilen) zu schieben.
   * Markup, Klassen und `data-testid` der Zeile sind die der alten Liste.
   */
  import { anfangsBuchstabe } from '$lib/utils/anfangsBuchstabe';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import ZeilenMenue from './ZeilenMenue.svelte';
  import { chatZeilenAktionen } from './chatZeilenAktionen';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { kurzeUhrzeit } from '$lib/utils/kurzeUhrzeit';
  import { currentLocale } from '$lib/i18n';
  import type { DMChannel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let { dm, onSelect }: { dm: DMChannel; onSelect: (dm: DMChannel) => void } = $props();

  const ungelesen = $derived(readState.isUnread(dm.id));
  const zahl = $derived(readState.getUnreadCount(dm.id));
  const u = $derived(userCache.get(dm.other_user_id));
  const bild = $derived(safeAvatarUrl(u?.avatar_url ?? null));
  const name = $derived(userCache.displayName(dm.other_user_id));
  const text = $derived(vorschau());
  const aktionen = $derived(chatZeilenAktionen(dm.id));

  /**
   * Der Ausschnitt unter dem Namen. Die beiden Marker aus `dm_vorschau.py`
   * werden hier zu Wörtern — der Server schickt bewusst keinen Dateinamen.
   */
  function vorschau(): string {
    const roh = dm.last_message_preview;
    if (!roh) return '';
    let klartext = roh;
    if (roh === '__image__') klartext = m.dm_preview_image();
    else if (roh === '__file__') klartext = m.dm_preview_file();
    // Private Nachrichten sind cloud-gebunden (`CloudOnly` im Gateway) —
    // die eigene Kennung ist deshalb die des Kontos, nicht die server-lokale.
    const vonMir = !!auth.user && dm.last_message_author_id === auth.user.id;
    return vonMir ? m.dm_preview_own_prefix() + klartext : klartext;
  }
</script>

<div class="relative">
  <button
    class="hover:bg-bg-hover handy-druck border-border bg-bg-input flex w-full items-center gap-3 rounded-[14px] border p-2.5 text-left transition-colors {aktionen.length > 0 ? 'handy:pr-14' : ''}"
    onclick={() => onSelect(dm)}
    data-testid={`chat-row-${dm.id}`}
    data-unread={ungelesen}
  >
    <span class="relative size-[46px] shrink-0">
      {#if bild}
        <img src={bild} alt="" class="size-full rounded-full object-cover" />
      {:else}
        <span
          class="flex size-full items-center justify-center rounded-full text-base font-bold text-white"
          style="background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));"
          >{anfangsBuchstabe(name)}</span
        >
      {/if}
      <StatusDot
        status={presence.displayStatusForFriend(dm.other_user_id)}
        class="ring-bg-panel absolute -right-px -bottom-px size-[13px] ring-[3px]"
      />
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-2">
        <span
          class="truncate text-sm font-semibold {ungelesen
            ? 'text-text-bright'
            : 'text-text-base'}"
          style={nameStyle(dm.other_user_id)}>{name}</span
        >
        {#if zahl > 0}
          <span
            class="bg-badge-count text-2xs ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 font-extrabold leading-none text-white"
            data-testid="chat-row-unread"
            data-unread-count={zahl}
            aria-label={m.nav_tab_unread_badge({ count: zahl })}
            >{zahl > 99 ? '99+' : zahl}</span
          >
        {:else if dm.last_message_at}
          <time class="text-text-muted text-2xs ml-auto shrink-0"
            >{kurzeUhrzeit(dm.last_message_at, new Date(), currentLocale())}</time
          >
        {/if}
      </span>
      {#if text}
        <span
          class="block truncate text-xs {ungelesen
            ? 'text-text-bright font-medium'
            : 'text-text-muted'}">{text}</span
        >
      {/if}
    </span>
  </button>
  <ZeilenMenue {aktionen} testid={`chat-menu-${dm.id}`} />
</div>
