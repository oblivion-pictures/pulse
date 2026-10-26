<!--
  Häkchen „Nutzungsbedingungen akzeptiert" samt Hinweis auf die
  Datenschutzerklärung — bei der Registrierung und auf dem Sperrbildschirm
  `/agb-zustimmung` (Begründung in `services/auth/src/dcc_auth/agb.py`).

  Nur die AGB werden angehakt. Die Datenschutzerklärung ist ein Hinweis, keine
  Einwilligung: der Dienst stützt sich auf Vertrag und berechtigtes Interesse
  (Art. 6 Abs. 1 lit. b/f DSGVO), und eine Einwilligung wäre jederzeit
  widerrufbar — ein Häkchen dafür versprach etwas, das so nicht gilt.

  Die Links öffnen in einem neuen Tab, damit ein halb ausgefülltes Formular
  nicht verloren geht.

  Auf einem Self-Host (lokale Konten) erscheint nichts: dort gelten unsere AGB
  nicht, und der Server fragt das Häkchen nicht ab (`$lib/legal/cloudServer`).
-->
<script lang="ts" module>
  import { ApiError } from '$lib/api/client';

  /** Hat der Server die Registrierung wegen des fehlenden Häkchens abgelehnt
   *  (`agb_required`, `dcc_auth/agb.py`)? Er prüft selbst, damit weder ein
   *  alter Client noch ein direkter Aufruf die Zustimmung überspringt. */
  export function istAgbFehler(err: unknown): boolean {
    const body = err instanceof ApiError ? (err.body as { detail?: { error?: string } } | null) : null;
    return body?.detail?.error === 'agb_required';
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { istCloudServer } from '$lib/legal/cloudServer';
  import { m } from '$lib/paraglide/messages.js';

  let {
    checked = $bindable(false),
    testid,
    required = false
  }: { checked?: boolean; testid: string; required?: boolean } = $props();

  let cloud = $state(true);
  onMount(async () => {
    cloud = await istCloudServer();
  });
</script>

{#if cloud}
  <div class="space-y-2 text-left">
    <label class="text-muted-foreground flex cursor-pointer items-start gap-2.5 text-sm">
      <Checkbox class="mt-0.5" bind:checked {required} data-testid={testid} />
      <span>
        {m.agb_haekchen_vor()}
        <a class="text-primary hover:underline" href="/agb" target="_blank" rel="noopener">
          {m.agb_haekchen_link()}</a
        >{m.agb_haekchen_nach()}
      </span>
    </label>
    <p class="text-muted-foreground text-xs">
      {m.agb_datenschutz_vor()}
      <a class="text-primary hover:underline" href="/datenschutz" target="_blank" rel="noopener">
        {m.agb_datenschutz_link()}</a
      >.
    </p>
  </div>
{/if}
