<script lang="ts">
  /**
   * Der Inhalt eines Kontextmenüs aus einer Aktionsliste (`zeilenAktionen.ts`).
   * Muss INNERHALB von `ContextMenu.Root` stehen. Markup je Eintrag wie vorher
   * in den Kanal-Abschnitten, `data-testid` unverändert.
   */
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import type { ZeilenAktion } from './zeilenAktionen';

  let { aktionen, handy = false }: { aktionen: ZeilenAktion[]; handy?: boolean } = $props();

  const sichtbar = $derived(aktionen.filter((a) => !(handy && a.nurDesktop)));
</script>

<ContextMenu.Content>
  {#each sichtbar as a (a.id)}
    {#if a.trenner}
      <ContextMenu.Separator />
    {/if}
    {#if a.schalter}
      <ContextMenu.CheckboxItem
        checked={a.schalter.checked}
        onCheckedChange={a.schalter.onChange}
        data-testid={a.testid}
      >
        {a.label}
      </ContextMenu.CheckboxItem>
    {:else}
      {@const Icon = a.icon}
      <ContextMenu.Item
        variant={a.variant === 'danger' ? 'destructive' : 'default'}
        onSelect={a.onSelect}
        data-testid={a.testid}
      >
        {#if Icon}<Icon />{/if}
        {a.label}
      </ContextMenu.Item>
    {/if}
  {/each}
</ContextMenu.Content>
