<script lang="ts">
  /**
   * Eine Aktionsliste (`menu/zeilenAktionen.ts`) als Blatt von unten, Zeilen als
   * `MenuRow density="comfortable"` (48 dp). Der Ersatz für Popover im
   * Desktop-Stil am Handy: ein kleines Menü an der Stelle des Daumens ist dort
   * schlecht zu treffen und liegt oft halb ausserhalb des Bildes.
   *
   * Die Aktion läuft ZUERST, das Blatt schliesst danach — wie im
   * `MessageActionSheet`, damit ein Dialog, den die Aktion öffnet, nicht gegen
   * das Schliessen läuft.
   */
  import CheckIcon from '@lucide/svelte/icons/check';
  import BottomSheet from './BottomSheet.svelte';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';
  import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    aktionen,
    testid,
    titel
  }: {
    open?: boolean;
    aktionen: ZeilenAktion[];
    testid: string;
    titel?: string;
  } = $props();

  const sichtbar = $derived(aktionen.filter((a) => !a.nurDesktop));

  function waehlen(a: ZeilenAktion): void {
    a.onSelect?.();
    open = false;
  }
</script>

<BottomSheet
  {open}
  {testid}
  closeLabel={m.zeilen_menue_schliessen()}
  ariaLabel={titel}
  panelClass="bg-popover text-popover-foreground relative max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-border pb-[var(--safe-bottom)] shadow-2xl"
  onClose={() => (open = false)}
>
  <div class="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border"></div>
  {#if titel}
    <p class="text-text-muted truncate px-4 pt-1 pb-2 text-sm font-semibold">{titel}</p>
  {/if}
  {#each sichtbar as a (a.id)}
    {#if a.trenner}
      <div class="my-1 border-t border-border"></div>
    {/if}
    {@const Icon = a.icon}
    <MenuRow
      density="comfortable"
      variant={a.variant}
      data-testid={a.testid}
      onclick={() => waehlen(a)}
    >
      {#if Icon}<Icon class="size-5 shrink-0 {a.variant ? '' : 'text-text-muted'}" />{/if}
      {a.label}
      {#if a.haken}
        <CheckIcon class="text-primary ml-auto size-5 shrink-0" aria-hidden="true" />
      {/if}
      {#if a.zahl && a.zahl > 0}
        <span
          class="bg-rose-500 text-2xs ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-semibold leading-none text-white"
          data-testid={a.zahlTestid}>{a.zahl}</span
        >
      {/if}
    </MenuRow>
  {/each}
</BottomSheet>
