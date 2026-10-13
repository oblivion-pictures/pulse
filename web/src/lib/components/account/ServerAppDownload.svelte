<!--
  Heim-Server: Download der Pulse Server-App, im Dialog „Eigenen Server
  einrichten“ unter „Auf diesem Rechner“ bzw. „Auf einem eigenen Rechner“
  (EigenerServerDialog — der trägt die Erklärung, hier steht nur noch der
  Knopf).

  Seit dem Selbstbedienungs-Entscheid (2026-09-27) braucht es keine
  Freischaltung und keinen Antrag mehr: Server-App installieren, mit dem
  howispulse.com-Konto einloggen — die Registrierung passiert beim ersten
  Start von selbst. Gezeigt wird der Download für das laufende System; ohne
  erkennbare Plattform alle drei.
-->
<script lang="ts">
  import { isLinux, isWindows, isMac } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import {
    WINDOWS_SERVER_INSTALLER_URL as WIN_URL,
    MAC_SERVER_DMG_URL as DMG_URL,
    LINUX_SERVER_FLATPAKREF_URL as FLATPAKREF
  } from '$lib/downloads/appDownloads';

  // Download-Ziele stehen an EINER Stelle (`appDownloads.ts`, Quellen dort
  // erklärt): Windows/macOS aus dem GitHub-Release, das Flatpak vom eigenen
  // Server.

  // Am Finger (Handy, Tablet) 48 dp hoch (Basis-Klasse), am Rechner ohne
  // Mindesthöhe (`desktop:`).
  const KNOPF =
    'inline-flex min-h-12 desktop:min-h-auto w-fit items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors';
  const PRIMAER = `${KNOPF} bg-primary hover:bg-primary/90 text-white`;
  const SEKUNDAER = `${KNOPF} border border-border text-text-bright hover:bg-bg-hover`;

  // Erkannte Plattform zuerst; ohne Signal alle drei (User wählt selbst).
  const showWindows = $derived(isWindows());
  const showMac = $derived(!showWindows && isMac());
  // Nur bei erkanntem Linux allein — sonst stünde der Linux-Knopf bei
  // unbekannter Plattform zweimal da (einzeln UND in der Dreierreihe).
  const showFlatpak = $derived(!showWindows && !showMac && isLinux());
  const showAll = $derived(!showWindows && !showMac && !isLinux());

</script>

<section class="flex flex-col gap-4" data-testid="server-app-download">
  {#if showWindows}
    <div class="flex flex-col gap-2">
      <a href={WIN_URL} class={PRIMAER} data-testid="server-app-download-windows">
        <DownloadIcon class="size-4" />
        {m.server_app_download_windows_btn()}
      </a>
      <p class="text-text-muted text-xs">{m.server_app_download_windows_hint()}</p>
    </div>
  {:else if showMac}
    <div class="flex flex-col gap-2">
      <a href={DMG_URL} class={PRIMAER} data-testid="server-app-download-mac">
        <DownloadIcon class="size-4" />
        {m.server_app_download_mac_btn()}
      </a>
      <p class="text-text-muted text-xs">{m.server_app_download_mac_hint()}</p>
    </div>
  {:else if showFlatpak}
    <div class="flex flex-col gap-2">
      <a href={FLATPAKREF} class={PRIMAER} data-testid="server-app-download-linux">
        <DownloadIcon class="size-4" />
        {m.server_app_download_linux_btn()}
      </a>
      <p class="text-text-muted text-xs">{m.server_app_download_linux_hint()}</p>
    </div>
  {/if}

  {#if showAll}
    <div class="flex flex-col gap-2" data-testid="server-app-download-all">
      <a href={WIN_URL} class={PRIMAER} data-testid="server-app-download-windows">
        <DownloadIcon class="size-4" />
        {m.server_app_download_windows_btn()}
      </a>
      <a href={DMG_URL} class={SEKUNDAER} data-testid="server-app-download-mac">
        <DownloadIcon class="size-4" />
        {m.server_app_download_mac_btn()}
      </a>
      <a href={FLATPAKREF} class={SEKUNDAER} data-testid="server-app-download-linux">
        <DownloadIcon class="size-4" />
        {m.server_app_download_linux_btn()}
      </a>
    </div>
  {/if}
</section>
