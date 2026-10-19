<!--
  FensterAbzeichen — blaue Pille oben rechts auf der Teilnehmer-Kachel eines
  Streamers, dessen Stream bei DIESEM Zuschauer im eigenen Player-Fenster
  läuft.

  Seit 2026-10-19 verschwindet die Kachel eines Fenster-Stroms aus dem Raster
  (`StreamGrid.svelte`). Mit ihr ging der Knopf „Fenster nach vorne holen“ —
  und den braucht es weiter: das Fenster öffnet ohne Aktivierung und liegt
  gern hinter der App. Er sitzt jetzt hier, am Streamer selbst.

  Ein Klick holt ALLE Fenster dieses Streamers nach vorne (mehrere Bildschirme
  = mehrere Fenster); welches man meinte, wäre an dieser Stelle nur geraten.
  Die Kachel liegt in einem `<button>` (Profil-Popover) — deshalb wie die
  LIVE-Pille ein `span role="button"` mit `stopPropagation`, sonst ginge mit
  jedem Klick zusätzlich das Profil auf.
-->
<script lang="ts">
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import { nativePlayerSessions } from '$lib/player/store.svelte';
  import { offeneFenster } from '$lib/player/imFenster';
  import { m } from '$lib/paraglide/messages.js';

  let { channelId, userId, name }: { channelId: string; userId: string; name: string } =
    $props();

  let fenster = $derived(offeneFenster(nativePlayerSessions.fuerHost(channelId, userId)));

  function nachVorne(e: Event): void {
    e.stopPropagation();
    for (const s of fenster) s.focus();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    nachVorne(e);
  }
</script>

{#if fenster.length > 0}
  <span
    role="button"
    tabindex="0"
    class="absolute right-2 top-2 z-10 inline-flex cursor-pointer items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-2xs font-semibold text-white shadow-sm hover:bg-blue-500 active:scale-95"
    data-testid="voice-participant-fenster-badge"
    title={m.voice_participant_fenster_badge_title()}
    aria-label={m.voice_participant_fenster_badge_aria({ name })}
    onclick={nachVorne}
    onkeydown={onKeydown}
  >
    <AppWindowIcon class="size-3" />
    {m.voice_participant_fenster_badge()}
  </span>
{/if}
