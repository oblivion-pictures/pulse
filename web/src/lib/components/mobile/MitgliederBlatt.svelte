<script lang="ts">
  /**
   * Die Mitgliederliste einer Community als Blatt von unten (Handy). Am Rechner
   * steht sie als Spalte neben dem Chat (`ChatView`); dort gibt es keinen Platz
   * dafür, und die Taste im Kanalkopf war am Handy bis hierher ausgeblendet.
   *
   * Dieselbe `MemberList` wie am Rechner — Presence, Rollen, Aktivitäts-Marken
   * und Standplatz-Geräte kommen mit. Das Blatt hat eine feste Höhe, weil die
   * Liste virtualisiert ist und eine Elternhöhe braucht.
   */
  import BottomSheet from './BottomSheet.svelte';
  import MemberList from '$lib/components/MemberList.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    guildId
  }: { open?: boolean; guildId: string } = $props();
</script>

<BottomSheet
  {open}
  testid="members-sheet"
  panelTestid="members-sheet-panel"
  closeLabel={m.zeilen_menue_schliessen()}
  ariaLabel={m.community_aktion_mitglieder()}
  panelClass="bg-popover text-popover-foreground border-border relative flex h-[80dvh] flex-col overflow-hidden rounded-t-2xl border-t pb-[var(--safe-bottom)] shadow-2xl"
  onClose={() => (open = false)}
>
  <div class="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border"></div>
  <div class="min-h-0 flex-1">
    <MemberList {guildId} onClose={() => (open = false)} />
  </div>
</BottomSheet>
