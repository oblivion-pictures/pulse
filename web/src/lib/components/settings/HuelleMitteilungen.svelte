<!--
  Mitteilungen in der iOS-Hülle — Stand und der Weg, sie später zu erlauben
  (iOS-Bughunt 2, F3).

  **Warum es diesen Abschnitt gibt.** Die Einstellungen kannten nur Web-Push,
  und den gibt es in der WKWebView nicht: die Seite meldete „nicht
  unterstützt". Wer die Vorerklärung zur Mitteilungsfrage mit „Später"
  weggetippt hatte, fand damit keinen Weg zurück — und weil iOS eine App ohne
  je gestellte Frage nicht unter Einstellungen → Mitteilungen führt (laut
  Bughunt, am Gerät nicht gemessen), auch dort keinen.

  Drei Stände: offen → „Erlauben" stellt den System-Dialog direkt;
  verweigert → der Dialog kommt auf iOS nie wieder, also führt der Knopf in
  die iOS-Einstellungen der App (`app-settings:` — Capacitor reicht eine
  fremde Adresse ans System weiter, `WebViewDelegationHandler`; im Simulator
  nicht ausgelöst); erteilt → nur der Stand.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { Stand } from '$lib/platform/berechtigungRegel';
  import { mitteilungenJetztErlauben, mitteilungenStand } from '$lib/platform/fcm';

  let stand = $state<Stand | null>(null);
  let busy = $state(false);

  async function auffrischen(): Promise<void> {
    stand = await mitteilungenStand();
  }

  onMount(() => {
    void auffrischen();
    // Aus den iOS-Einstellungen zurück: der Stand kann sich dort geändert haben.
    const beiSichtbar = () => {
      if (document.visibilityState === 'visible') void auffrischen();
    };
    document.addEventListener('visibilitychange', beiSichtbar);
    return () => document.removeEventListener('visibilitychange', beiSichtbar);
  });

  async function erlauben(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      stand = (await mitteilungenJetztErlauben()) ?? stand;
    } finally {
      busy = false;
    }
  }

  const text = $derived.by(() => {
    switch (stand) {
      case 'erteilt':
        return m.settings_mitteilungen_huelle_erteilt();
      case 'verweigert':
        return m.settings_mitteilungen_huelle_verweigert();
      case 'offen':
        return m.settings_mitteilungen_huelle_offen();
      default:
        return null;
    }
  });
</script>

{#if text}
  <section
    class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4"
    data-testid="settings-notifications-huelle"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex flex-col gap-1">
        <span class="text-text-bright text-sm font-medium">{m.settings_mitteilungen_huelle_titel()}</span>
        <span class="text-text-muted text-xs">{text}</span>
      </div>
      {#if stand === 'offen'}
        <!-- h-12: Trefferfläche ≥ 48 dp, die Hülle läuft nur auf Handy und Tablet. -->
        <Button onclick={erlauben} disabled={busy} class="h-12 shrink-0">
          {busy ? '…' : m.berechtigung_weiter()}
        </Button>
      {:else if stand === 'verweigert'}
        <Button
          variant="outline"
          class="h-12 shrink-0"
          onclick={() => (window.location.href = 'app-settings:')}
        >
          {m.settings_mitteilungen_huelle_einstellungen()}
        </Button>
      {/if}
    </div>
  </section>
{/if}
