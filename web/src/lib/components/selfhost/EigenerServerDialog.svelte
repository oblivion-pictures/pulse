<!--
  „Eigenen Server einrichten“ (Spec 2026-10-09-selfhost-ohne-freigabe-design.md
  §5) — der eine Einstieg für alle Wege zu einem eigenen Server. Ersetzt die
  Seite „Eigener Server“ mit Antragsformular: kein Antrag, kein Warten.

  Ein Inhalt, zwei Hüllen: am Rechner und Tablet ein Dialog, am Handy ein Blatt
  von unten. Welche, entscheidet der Mount-Punkt im App-Layout (`blatt`) —
  Geräte-Trennung: diese Komponente fragt nicht selbst nach dem Gerät. Das
  Blatt läuft über `BottomSheet` (Portal; `glass-panel` hat `backdrop-filter`,
  `position: fixed` bezöge sich sonst nicht aufs Fenster).

  Ein zweites Zeichen kommt vom selben Mount-Punkt: `finger` (Handy UND Tablet).
  Am Finger gilt der Wortlaut „auf einem eigenen Rechner“ — die Server-App läuft
  dort nicht auf dem Gerät in der Hand — und die Trefferflächen sind 48 dp hoch.
  Am Rechner bleibt es bei „auf diesem Rechner“.

  Der Dialog schließt bei jeder Navigation (`afterNavigate`): er hängt am
  Store, nicht an der Adresse, und bliebe nach „Zurück“ (Android-System-Back)
  sonst über der vorigen Seite stehen.

  Geöffnet über `uiOverlays.eigenerServerOpen` — vom Plus jeder Server-Gruppe
  (`GuildRailPlusMenu`) und vom Menü der Räume (`RaeumeMenue`).
-->
<script lang="ts">
  import type { Component } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import ServerAppDownload from '$lib/components/account/ServerAppDownload.svelte';
  import SelfHostInstallCard from './SelfHostInstallCard.svelte';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import ServerIcon from '@lucide/svelte/icons/server';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import { afterNavigate } from '$app/navigation';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { blatt, finger }: { blatt: boolean; finger: boolean } = $props();

  function schliessen(): void {
    uiOverlays.eigenerServerOpen = false;
  }

  afterNavigate(schliessen);

  const rechnerTitel = $derived(
    finger ? m.eigener_server_rechner_finger_titel() : m.eigener_server_rechner_titel()
  );
  const rechnerText = $derived(
    finger ? m.eigener_server_rechner_finger_text() : m.eigener_server_rechner_text()
  );

  const KARTE = 'border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4';
</script>

{#snippet kopf(icon: Component, titel: string, text: string, abzeichen?: string)}
  {@const Icon = icon}
  <div class="flex items-start gap-3 text-left">
    <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
      <Icon class="size-5" />
    </span>
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="flex items-center gap-1.5">
        <h3 class="text-text-bright text-sm font-semibold">{titel}</h3>
        {#if abzeichen}
          <span
            class="bg-bg-input text-text-muted rounded-full px-1.5 py-0.5 text-2xs font-medium tracking-wide uppercase"
            >{abzeichen}</span
          >
        {/if}
      </span>
      <p class="text-text-muted text-xs">{text}</p>
    </div>
  </div>
{/snippet}

{#snippet wege()}
  <!-- `data-finger`: Marker für die Trefferflächen (48 dp) der Wege-Karten. Das
       Blatt UND der Dialog stehen im Portal, außerhalb von `.geraet-handy` —
       die Geräte-Varianten (`handy:`/`nicht-handy:`) sehen sie dort nicht,
       `nicht-handy:` träfe dort immer zu. `contents`: der Wrapper bleibt für
       Layout und Abstand unsichtbar. -->
  <div data-finger={finger ? '' : undefined} class="contents">
    <p class="text-text-muted text-sm">{m.hosting_apply_mode_label()}</p>
    <section class={KARTE} data-testid="eigener-server-rechner">
      {@render kopf(MonitorIcon, rechnerTitel, rechnerText)}
      <ServerAppDownload />
    </section>
    <section class={KARTE} data-testid="eigener-server-gemietet">
      {@render kopf(ServerIcon, m.eigener_server_gemietet_titel(), m.eigener_server_gemietet_text())}
      <SelfHostInstallCard />
    </section>
    <!-- „Von Pulse gehostet“ gibt es noch nicht. Der Hinweis hing am
         Antragsformular und wäre mit ihm verschwunden — ausgegraut stehen lassen
         (Entscheid des Eigentümers, 2026-10-10). `role="group"`: ohne Rolle
         liest kein Hilfsmittel das `aria-disabled` eines Divs aus. -->
    <div
      class="{KARTE} cursor-not-allowed opacity-60"
      role="group"
      aria-disabled="true"
      data-testid="eigener-server-gehostet"
    >
      {@render kopf(
        CloudIcon,
        m.hosting_apply_mode_managed_title(),
        m.hosting_apply_mode_managed_desc(),
        m.hosting_apply_mode_managed_badge()
      )}
    </div>
    <Button
      variant="outline"
      class="w-full in-data-[finger]:h-12"
      onclick={schliessen}
      data-testid="eigener-server-schliessen"
    >
      {m.eigener_server_schliessen()}
    </Button>
  </div>
{/snippet}

{#if blatt}
  <BottomSheet
    open={uiOverlays.eigenerServerOpen}
    testid="eigener-server-blatt"
    closeLabel={m.eigener_server_schliessen()}
    panelClass="bg-popover text-popover-foreground border-border relative flex max-h-[85dvh] flex-col gap-4 overflow-y-auto rounded-t-[22px] border-t p-4 pb-[max(1rem,var(--safe-bottom))] shadow-2xl"
    panelTestid="eigener-server-dialog"
    onClose={schliessen}
  >
    <div class="bg-border mx-auto h-1 w-9 shrink-0 rounded-full"></div>
    <h2 class="text-text-bright text-lg font-semibold">{m.eigener_server_einrichten()}</h2>
    {@render wege()}
  </BottomSheet>
{:else}
  <Dialog.Root
    open={uiOverlays.eigenerServerOpen}
    onOpenChange={(v) => {
      if (!v) schliessen();
    }}
  >
    <!-- Das Kreuz bringt der Dialog selbst mit (klein, `icon-sm`): am Finger auf
         48 dp, wie jede andere Fläche hier. -->
    <Dialog.Content
      class="max-h-[90dvh] gap-4 overflow-y-auto nicht-handy:max-w-lg"
      closeClass={finger ? 'top-2 right-2 size-12' : undefined}
      data-testid="eigener-server-dialog"
    >
      <Dialog.Title>{m.eigener_server_einrichten()}</Dialog.Title>
      {@render wege()}
    </Dialog.Content>
  </Dialog.Root>
{/if}
