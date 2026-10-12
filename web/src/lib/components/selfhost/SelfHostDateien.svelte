<!--
  Die Dateien für den Weg „von Hand“ im Dialog „Eigenen Server einrichten“:
  beide Compose-Dateien, das Update-Skript und das Installationsskript selbst.
  Der Befehl darüber (`SelfHostInstallCard`) bleibt der Normalweg, das hier ist
  für alle, die lieber lesen und selbst starten — oder deren Rechner kein
  `curl | bash` mag.

  Die Dateien kommen immer von der Cloud (`CLOUD_HOSTNAME`), aus demselben Grund
  wie der Befehl: Self-Hosts liefern sie nicht aus. Es sind statische Dateien
  ohne Geheimnisse, für jeden gleich (`infra/self-host/` → `/self-host/*`,
  `web/static/install.sh` → `/install.sh`).

  Was ein Klick tut, hängt vom Ursprung ab, denn `download` wirkt nur bei
  gleichem Ursprung:
  - Seite von der Cloud (Browser, Electron-Fenster): der Browser speichert
    unter dem Dateinamen. Electron zeigt dabei das Speichern-Fenster des
    Betriebssystems (`will-download` ohne Handler, `desktop/electron/**`).
  - Seite von woanders (Self-Host-Adresse, Dev-Server): `download` greift nicht,
    der Klick wäre eine Navigation und risse die App weg. Deshalb dort ein neuer
    Tab (`target="_blank"`); die Textdateien zeigt der Browser dann an (nginx
    liefert sie als `text/plain`, zum Speichern „Seite speichern“), das
    Installationsskript (`application/octet-stream`) lädt er herunter.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import FileDownIcon from '@lucide/svelte/icons/file-down';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const DATEIEN = [
    {
      name: 'docker-compose.yml',
      pfad: '/self-host/docker-compose.yml',
      hinweis: () => m.eigener_server_datei_compose()
    },
    {
      name: 'docker-compose.behind-proxy.yml',
      pfad: '/self-host/docker-compose.behind-proxy.yml',
      hinweis: () => m.eigener_server_datei_proxy()
    },
    {
      name: 'pulse-update.sh',
      pfad: '/self-host/pulse-update.sh',
      hinweis: () => m.eigener_server_datei_update()
    },
    {
      name: 'install.sh',
      pfad: '/install.sh',
      hinweis: () => m.eigener_server_datei_installer()
    }
  ];

  const gleicherUrsprung = window.location.origin === CLOUD_HOSTNAME;
</script>

<div class="border-border flex flex-col gap-2 border-t pt-3" data-testid="self-host-dateien">
  <h4 class="text-text-bright text-xs font-semibold">{m.eigener_server_dateien_titel()}</h4>
  <p class="text-text-muted text-xs">{m.eigener_server_dateien_text()}</p>
  <ul class="flex flex-col gap-2">
    {#each DATEIEN as datei (datei.name)}
      <li class="flex flex-col items-start gap-1">
        <!-- Am Finger (Handy, Tablet) 48 dp hoch (Basis-Klasse), am Rechner die
             schlanke Größe von `size="xs"` (`desktop:`) — wie der Kopieren-Knopf. -->
        <Button
          size="xs"
          variant="outline"
          class="h-12 px-4 desktop:h-6 desktop:px-2.5"
          href="{CLOUD_HOSTNAME}{datei.pfad}"
          download={datei.name}
          target={gleicherUrsprung ? undefined : '_blank'}
          rel="noopener"
          aria-label={m.eigener_server_datei_laden({ name: datei.name })}
          data-testid="self-host-datei-{datei.name}"
        >
          <FileDownIcon class="size-3.5" />
          {datei.name}
        </Button>
        <span class="text-text-muted text-xs">{datei.hinweis()}</span>
      </li>
    {/each}
  </ul>
</div>
