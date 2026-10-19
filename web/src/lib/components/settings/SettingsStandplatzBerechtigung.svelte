<script lang="ts">
  /**
   * Warum dieser Rechner nicht ferngesteuert werden kann — mit dem Weg zur
   * richtigen Systemeinstellung.
   *
   * **Nicht zu verwechseln mit `DeviceFreigaben`**: das ist die
   * Liste, WER diesen Rechner steuern darf. Hier geht es darum, ob er es
   * ueberhaupt KANN — eine Frage an das Betriebssystem, nicht an den Server.
   *
   * Den Text baut `lib/remote/freigabeText.ts` (rein und getestet), den Grund
   * liefert der Sidecar; hier steht bewusst keine Fallunterscheidung.
   *
   * **Seit 2026-10-19 mit zwei Knoepfen** (nur macOS, nur wo die Desktop-App
   * den Weg hat): „Freigabe anfordern" laesst den Sidecar die erste fehlende
   * Freigabe anfragen (`freigabe_anfragen`; der Dialog heisst „Pulse"), und
   * „Systemeinstellungen oeffnen" schlaegt die passende Liste auf. Bis dahin
   * fragte niemand je an — Pulse erschien nie von selbst in den Listen, und der
   * Hinweis verwies auf einen Sitzungsversuch, den es ohne Eintragung nicht
   * gab. Nach jedem Klick wird neu gemessen; die Rueckkehr ins Fenster misst
   * der Rail-Knopf (`StandplatzRailButton`).
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import { freigabeHinweis } from '$lib/remote/freigabeText';
  import { sidecar } from '$lib/stream/sidecar';
  import { pruefeGesundheitErneut, stream } from '$lib/stream/state.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const kannAnfragen = sidecar.kannFreigabeAnfragen();
  const hinweis = $derived(freigabeHinweis(stream.fernsteuerbarGrund, kannAnfragen));

  let laeuft = $state(false);

  async function anfordern(): Promise<void> {
    laeuft = true;
    try {
      await sidecar.freigabeAnfragen();
      await pruefeGesundheitErneut();
    } finally {
      laeuft = false;
    }
  }

  function einstellungenOeffnen(): void {
    if (hinweis?.einstellung) void sidecar.freigabeEinstellungen(hinweis.einstellung);
  }
</script>

{#if hinweis}
  <div class="border-border rounded-2xl border p-4 text-sm" data-testid="standplatz-freigabe">
    <p class="text-text font-medium">{hinweis.ueberschrift}</p>
    <p class="text-text-muted mt-1">{hinweis.erklaerung}</p>
    {#if hinweis.pfad}
      <p class="text-text-muted mt-2 font-mono text-xs">{hinweis.pfad}</p>
    {/if}
    {#if kannAnfragen && hinweis.einstellung}
      <div class="mt-3 flex flex-wrap gap-2">
        {#if hinweis.anfragbar}
          <Button
            size="sm"
            disabled={laeuft}
            onclick={anfordern}
            data-testid="standplatz-freigabe-anfordern"
          >
            {m.standplatz_freigabe_anfordern()}
          </Button>
        {/if}
        <Button
          size="sm"
          variant="outline"
          onclick={einstellungenOeffnen}
          data-testid="standplatz-freigabe-einstellungen"
        >
          {m.standplatz_freigabe_einstellungen()}
        </Button>
      </div>
    {/if}
  </div>
{/if}
