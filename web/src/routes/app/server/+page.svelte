<!--
  /app/server — „Meine Server“: die eigenen Server des Kontos mit Diagnose und
  Löschen (Spec 2026-10-09 §5). Seit dem Wegfall der Freigabe (2026-10) steht
  hier nur noch die Verwaltung; Einrichten läuft über den Dialog „Eigenen
  Server einrichten“ (Plus der Leiste, Menü der Räume).

  Einstiege: „Meine Server“ im Konto-Menü (am Rechner) und im Du-Bereich (Handy
  und Tablet), beide nur mit eigenem Server; dazu der Betreiber-Hinweis
  „Verlassen geht nicht“ und „Eigene Server verwalten“ im Kontextmenü eines
  eigenen Servers in der Leiste.

  Der Rahmen folgt `/app/invites`: am Rechner die GuildRail daneben, darunter
  ein Vollbild mit Zurück-Kopf wie `/app/me/[section]`.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import MyInstances from '$lib/components/account/MyInstances.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { selectGuild } from '$lib/navigation/railNavi';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Zurück dorthin, wo der Einstieg steht: auf Handgeräten der Du-Bereich, am
  // Rechner die Startseite (das Konto-Menü ist kein Ort, zu dem man
  // zurückkehrt). Klasse statt Fensterbreite — s. `viewport.svelte.ts`.
  let zurueckZiel = $derived(viewport.isDesktop ? '/app' : '/app/me');
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={currentServerUserId()}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
/>

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none nicht-handy:rounded-2xl"
  data-testid="self-host-page"
>
  <!-- Der Weg zurück gehört auf JEDE Größe: das hier ist ein aufgeschobener
       Bildschirm, keine der vier Bereichs-Seiten (deshalb auch kein
       `BereichsKopf`, der trägt bewusst keine Zurück-Geste). -->
  <header class="border-border text-text-bright flex h-14 shrink-0 items-center gap-1 border-b px-2">
    <button
      class="text-text-muted hover:text-primary flex min-h-12 min-w-12 items-center justify-center"
      onclick={() => goto(zurueckZiel)}
      data-testid="self-host-back"
      aria-label={m.settings_dialog_back()}
    >
      <ChevronLeftIcon class="size-6" />
    </button>
    <span class="truncate text-base font-bold tracking-tight">{m.eigener_server_meine_server()}</span>
  </header>

  <div class="flex-1 overflow-y-auto p-4 nicht-handy:p-6">
    <!-- Die Liste holt ihre Daten über `cookieFetch` und damit immer von der
         Cloud, unabhängig vom aktiven Server. -->
    <MyInstances />
  </div>
</section>
