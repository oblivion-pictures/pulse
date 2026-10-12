<!--
  Installationsbefehl für einen gemieteten Server (seit 2026-10 ohne Antrag
  und ohne Token): ein Befehl für alle, kein Geheimnis darin — deshalb
  statisch, ohne API. Den Rest erledigt der Installer: am Ende ruft er
  `pulse-connect`, das den Server über die Bestätigungsseite `/verbinden` mit
  dem Konto verbindet (Spec 2026-10-09, E1/E6).

  Befehl und Anleitung nennen immer die Cloud (`CLOUD_HOSTNAME`), nicht die
  Adresse, von der diese Seite geladen wurde: Self-Hosts liefern dieselbe
  Web-App aus (`infra/self-host/Dockerfile`, Stage `web-build`), aber weder
  `/install` noch `/self-host/guide` — ein Befehl mit ihrer Adresse liefe ins
  Leere.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const BEFEHL = `curl -fsSL ${CLOUD_HOSTNAME}/install | bash`;
  const ANLEITUNG = `${CLOUD_HOSTNAME}/self-host/guide`;

  let kopiert = $state(false);
  let zuruecksetzen: ReturnType<typeof setTimeout> | undefined;

  async function kopieren(): Promise<void> {
    try {
      await navigator.clipboard.writeText(BEFEHL);
    } catch {
      // Zwischenablage verweigert (ältere WebView, fehlende Berechtigung) —
      // der Befehl steht markierbar da (`select-all`).
      return;
    }
    kopiert = true;
    clearTimeout(zuruecksetzen);
    zuruecksetzen = setTimeout(() => (kopiert = false), 2000);
  }

  onDestroy(() => clearTimeout(zuruecksetzen));
</script>

<div class="flex flex-col gap-2" data-testid="self-host-install-card">
  <div class="flex items-center gap-2">
    <code
      class="bg-bg-input text-text-bright min-w-0 flex-1 overflow-x-auto rounded-md px-2 py-1.5 font-mono text-xs whitespace-nowrap select-all"
      data-testid="self-host-install-command">{BEFEHL}</code
    >
    <!-- Im Blatt (Handy) 48 dp hoch, sonst die schlanke Größe. Die Geräte-
         Varianten taugen hier nicht: das Blatt steht im Portal, also AUSSERHALB
         des `.geraet-handy`-Wurzel-Div, `nicht-handy:` träfe dort immer zu.
         Der Marker `data-blatt` kommt von `EigenerServerDialog`. -->
    <Button
      size="xs"
      variant="outline"
      class="in-data-[blatt]:h-12 in-data-[blatt]:px-4"
      onclick={kopieren}
      data-testid="self-host-install-copy"
    >
      {#if kopiert}
        <CheckIcon class="size-3.5" />
        {m.eigener_server_kopiert()}
      {:else}
        <CopyIcon class="size-3.5" />
        {m.eigener_server_kopieren()}
      {/if}
    </Button>
  </div>
  <p class="text-text-muted text-xs">{m.eigener_server_befehl_hinweis()}</p>
  <a
    class="text-primary inline-flex w-fit items-center text-xs underline-offset-2 hover:underline in-data-[blatt]:min-h-12"
    href={ANLEITUNG}
    target="_blank"
    rel="noopener"
    data-testid="self-host-install-guide"
  >
    {m.eigener_server_anleitung()}
  </a>
</div>
