<script lang="ts">
  /**
   * Die Statuswahl am Handy als Blatt von unten (Zeilen als
   * `MenuRow density="comfortable"`, 48 dp) statt als Dropdown mit 208 px Breite
   * über dem Daumen. Die Wahl selbst (`setStatus`, Zurückrollen bei Fehler)
   * bleibt in `StatusPicker.svelte`.
   */
  import BottomSheet from './BottomSheet.svelte';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import CheckIcon from '@lucide/svelte/icons/check';
  import type { OwnPresenceStatus } from '$lib/stores/presence.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    optionen,
    aktuell,
    onWaehlen
  }: {
    open?: boolean;
    optionen: { value: OwnPresenceStatus; label: string; description: string }[];
    aktuell: OwnPresenceStatus;
    onWaehlen: (status: OwnPresenceStatus) => void;
  } = $props();
</script>

<BottomSheet
  {open}
  testid="status-sheet"
  closeLabel={m.zeilen_menue_schliessen()}
  ariaLabel={m.status_picker_change_title()}
  panelClass="bg-popover text-popover-foreground relative max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-border pb-[var(--safe-bottom)] shadow-2xl"
  onClose={() => (open = false)}
>
  <div class="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border"></div>
  <p class="text-text-muted px-4 pt-1 pb-2 text-sm font-semibold">{m.status_picker_change_title()}</p>
  {#each optionen as o (o.value)}
    <MenuRow
      density="comfortable"
      data-testid="status-option-{o.value}"
      onclick={() => {
        onWaehlen(o.value);
        open = false;
      }}
    >
      <StatusDot status={o.value} class="size-3" />
      <span class="flex min-w-0 flex-col">
        <span class="text-text-bright text-base font-medium">{o.label}</span>
        <span class="text-text-muted text-xs">{o.description}</span>
      </span>
      {#if o.value === aktuell}
        <CheckIcon class="text-primary ml-auto size-5" aria-hidden="true" />
      {/if}
    </MenuRow>
  {/each}
</BottomSheet>
