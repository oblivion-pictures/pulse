<!--
  Hinweis an einem eigenen Server in „Meine Server“: ein anderes Pulse-Konto
  hat für diese Adresse eine Übernahme beantragt (Widerspruchsfrist, Spec
  2026-10-09 Nachtrag 2026-10-11). Der Eintrag trägt dann `uebernahme_frist_bis`.

  Wer den Server nicht abgegeben hat, widerspricht hier; wer ihn abgegeben hat,
  muss nichts tun — oder löscht ihn, dann geht es sofort (die Adresse ist danach
  frei). Einen eigenen Zustimmen-Knopf gibt es bewusst nicht.

  Eine eigene Komponente, damit `MyInstances` unter der Größengrenze bleibt. Die
  Rechnung hinter den Fehlertexten steht in `selfhost/widerspruch.ts`
  (Node-getestet); hier hängen nur Texte, Anfrage und Zustand dran.

  Nach einem Widerspruch lädt der Aufrufer die Liste neu (`onGeaendert`): der
  Antrag ist dann erledigt, der Eintrag trägt kein Fristende mehr, und dieser
  Hinweis verschwindet mit ihm.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { ApiError } from '$lib/api/client';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import { datumZeigen } from '$lib/verbinden/anzeige';
  import { widerspruchFehler, widerspruchSchluessel } from '$lib/selfhost/widerspruch';
  import { Button } from '$lib/components/ui/button';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  let { instanz, onGeaendert }: { instanz: Instance; onGeaendert: () => void } = $props();

  let laeuft = $state(false);
  let fehlertext = $state<string | null>(null);

  function meldung(err: unknown): { text: string; nichtMehr: boolean } {
    const art =
      err instanceof ApiError ? widerspruchFehler(err.status, err.body) : widerspruchFehler(null, null);
    const katalog = m as unknown as Record<string, (() => string) | undefined>;
    return {
      text: katalog[widerspruchSchluessel(art)]?.() ?? m.meine_server_uebernahme_fehler_sonst(),
      nichtMehr: art === 'nicht_mehr'
    };
  }

  async function widersprechen(): Promise<void> {
    if (laeuft) return;
    laeuft = true;
    fehlertext = null;
    try {
      await instancesApi.widersprechen(instanz.id);
      toast.success(m.meine_server_uebernahme_widersprochen());
      onGeaendert();
    } catch (err) {
      const { text, nichtMehr } = meldung(err);
      if (nichtMehr) {
        // Den Antrag gibt es nicht mehr (abgelaufen, vollzogen, schon
        // widersprochen): die Liste zeigt es nach dem Neuladen von selbst, und
        // der Hinweis mit seinem Text verschwindet dabei — also ein Toast.
        toast.error(text);
        onGeaendert();
      } else {
        fehlertext = text;
      }
    } finally {
      laeuft = false;
    }
  }
</script>

<div
  class="border-warning/40 bg-warning/10 flex flex-col gap-2 rounded-lg border p-3"
  data-testid="meine-server-uebernahme-{instanz.id}"
>
  <div class="flex items-start gap-2">
    <TriangleAlertIcon class="text-warning mt-0.5 size-4 shrink-0" />
    <p class="text-text-bright text-sm">
      {m.meine_server_uebernahme_text({ datum: datumZeigen(instanz.uebernahme_frist_bis) })}
    </p>
  </div>
  <p class="text-text-muted text-xs">{m.meine_server_uebernahme_abgegeben()}</p>
  {#if fehlertext}
    <p class="text-destructive text-xs" role="alert" data-testid="meine-server-widerspruch-fehler">
      {fehlertext}
    </p>
  {/if}
  <div>
    <Button
      variant="warning"
      size="xs"
      class="handy:h-12 handy:px-4 handy:text-sm"
      onclick={widersprechen}
      disabled={laeuft}
      data-testid="meine-server-widerspruch"
    >
      {m.meine_server_uebernahme_widersprechen()}
    </Button>
  </div>
</div>
