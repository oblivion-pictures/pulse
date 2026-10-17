<!--
  Dauerhaftes Banner „Bitte neu laden" (Gegenprüfung 2026-10-12, R4).

  Steht, solange der Riegel aus `verlauf/verbindung.ts` steht: ein anderes
  Fenster mit neuerem Code hat die Verlaufs-Datenbank angehoben. Dieser Tab
  legt dann nichts mehr ab, holt keine Zustellungen mehr ab und sendet nicht
  (R3). Bis dahin gab es nur einen Hinweis-Toast, einmal und nur auf der
  DM-Seite (`verlaufZustand.hinweisVerbrauchen`) — wer woanders stand oder ihn
  wegklickte, schrieb ins Leere weiter. Der Riegel fällt nie von selbst, das
  Banner auch nicht: erst das Neuladen holt den Code, der die Fassung kennt.

  Gerendert im App-Layout (`routes/app/+layout.svelte`), auf jedem Gerät
  gleich — keine Breakpoint-Varianten (`scripts/geraete-trennung.sh`); nur
  der Knopf bekommt auf Handy und Tablet die Trefferfläche von 48 dp.

  Abstand nach oben: eigenes `--safe-top` (Android, Tablet). In der iOS-Hülle am
  Handy trägt die Shell die Aussparung einmal für alle Banner
  (`routes/app/+layout.svelte`), dort bleibt nur `mt-2` — sonst stünde der
  Abstand doppelt.
-->
<script lang="ts">
  import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
  import { Button } from '$lib/components/ui/button/index.js';
  import { verlaufZustand } from '$lib/verlauf/zustand.svelte';
  import { m } from '$lib/paraglide/messages.js';
</script>

{#if verlaufZustand.verriegelt}
  <div
    class="mx-3 mt-[calc(var(--safe-top)+0.5rem)] ios:handy:mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/15 px-3 py-2 text-sm text-destructive"
    data-testid="verlauf-neu-laden-banner"
    role="alert"
  >
    <AlertCircleIcon class="size-4 shrink-0" />
    <span class="min-w-0 flex-1">{m.verlauf_neu_laden_banner()}</span>
    <Button
      size="sm"
      variant="outline"
      class="handy:min-h-12 tablet:min-h-12"
      onclick={() => location.reload()}
      data-testid="verlauf-neu-laden-knopf"
    >
      {m.verlauf_neu_laden_knopf()}
    </Button>
  </div>
{/if}
