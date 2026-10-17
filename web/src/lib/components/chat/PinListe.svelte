<script lang="ts">
  /**
   * „📌 N" im Kanalkopf samt Liste der angepinnten Nachrichten.
   *
   * Am Rechner ein Dropdown unter dem Knopf (wie bisher). Am Handy ein Blatt
   * von unten (`BottomSheet`, Zeilen als `MenuRow density="comfortable"`): ein
   * Popover im Desktop-Stil sitzt dort halb ausserhalb des Bildes und seine
   * Zeilen sind zu klein für einen Finger. Herausgelöst aus `ChatView.svelte`,
   * `data-testid` (`pins-toggle`, `pins-list`, `pin-entry`) unverändert.
   */
  import PinIcon from '@lucide/svelte/icons/pin';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';
  import { snippet80 } from '../messageRender';
  import type { Message } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    handy,
    pinCount,
    pins,
    authorName,
    onOeffnen,
    onSprung
  }: {
    handy: boolean;
    pinCount: number;
    pins: Message[] | null;
    authorName: (p: Message) => string;
    /** Beim Öffnen: Pins nachladen. */
    onOeffnen: () => void;
    onSprung: (messageId: string) => void;
  } = $props();

  let blattOffen = $state(false);
  const titel = $derived(m.chat_view_pins_title({ count: pinCount }));
</script>

{#snippet knopf(props: Record<string, unknown>)}
  <Button
    {...props}
    variant="ghost"
    size="icon"
    class="relative handy:size-11"
    onclick={() => {
      onOeffnen();
      if (handy) blattOffen = true;
    }}
    title={titel}
    aria-label={titel}
    data-testid="pins-toggle"
  >
    <PinIcon class="text-text-muted size-4" />
    <span
      class="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
      >{pinCount}</span
    >
  </Button>
{/snippet}

{#snippet eintrag(p: Message)}
  <PinIcon class="text-primary size-3.5 shrink-0" />
  <span class="min-w-0">
    <span class="text-text-bright block truncate text-xs font-semibold">{authorName(p)}</span>
    <span class="text-text-muted block truncate text-xs">{snippet80(p.content)}</span>
  </span>
{/snippet}

{#if handy}
  {@render knopf({})}
  <BottomSheet
    open={blattOffen}
    testid="pins-sheet"
    panelTestid="pins-list"
    closeLabel={m.zeilen_menue_schliessen()}
    panelClass="bg-popover text-popover-foreground border-border relative max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t pb-[var(--safe-bottom)] shadow-2xl"
    onClose={() => (blattOffen = false)}
  >
    <div class="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border"></div>
    <p class="text-text-muted px-4 pt-1 pb-2 text-sm font-semibold">{titel}</p>
    {#each pins ?? [] as p (p.id)}
      <MenuRow
        density="comfortable"
        data-testid="pin-entry"
        onclick={() => {
          blattOffen = false;
          onSprung(p.id);
        }}
      >
        {@render eintrag(p)}
      </MenuRow>
    {/each}
  </BottomSheet>
{:else}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        {@render knopf(props)}
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="max-h-80 w-80 overflow-y-auto" data-testid="pins-list">
      <DropdownMenu.Item class="text-text-muted text-xs font-semibold" disabled>
        {titel}
      </DropdownMenu.Item>
      {#each pins ?? [] as p (p.id)}
        <DropdownMenu.Item
          class="cursor-pointer gap-2"
          onclick={() => onSprung(p.id)}
          data-testid="pin-entry"
        >
          {@render eintrag(p)}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
