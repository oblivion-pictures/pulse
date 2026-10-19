<!--
  TileShell — gemeinsame Chrome für alle Video-Kacheln eines Voice-Channels
  (HQ-Stream, Screenshare, Webcam, Watch Party). Trägt Rahmen, Video-Fläche,
  die Steuerleiste (`TileDock`), Stats-Overlay, Fullscreen, Detach/Hide
  und die Chat-Slots. Die vier Tile-Komponenten liefern nur ihren Video-Inhalt
  + kind-spezifische Stücke als Snippets.

  Steuerung (Player-Stil): die Buttons liegen NICHT mehr auf dem Video, sondern
  in einer soliden Leiste DARUNTER (`TileDock overlay=false`). Nur im Vollbild
  wird die Leiste zum fadenden Overlay über dem unteren Bildrand
  (`overlay=true`) — immersiv, taucht bei Maus-/Tap-Aktivität auf und fadet nach
  2,5 s weg. Das gilt für alle Kacheln inkl. Watch-Party. Der transparente
  Klick-Fänger (Doppelklick → Vollbild) liegt nur über <video>-Kacheln, NICHT
  über der Watch-Party (kind 'party'): dort ist das Medium ein iframe, dessen
  native Controls der Fänger sonst blockieren würde.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import VideoIcon from '@lucide/svelte/icons/video';
  import ClapperboardIcon from '@lucide/svelte/icons/clapperboard';
  import { m } from '$lib/paraglide/messages.js';
  import { aufVollbildWechsel, eigenesVollbildNoetig, toggleFullscreen } from '../fullscreen';
  import { statsVisible } from '../statsVisible.svelte';
  import { querKacheln, querVollbildBeobachten } from '../querVollbildWache';
  import { kachelVollbildLage } from '../kachelVollbildLage.svelte';
  import TileDock from './TileDock.svelte';
  import TileMobilSteuerung from '$lib/components/mobile/TileMobilSteuerung.svelte';
  import type { TileShellProps } from './tileShellProps';

  let {
    kind,
    /** Handy-Klasse? Vom Mount-Punkt (Route/Hintergrund-Host) hereingereicht
     *  — s. tileShellProps. Ohne sie fragte die Kachel selbst den Viewport. */
    handy,
    containerTestid,
    testidPrefix,
    identity,
    name,
    nameTestid,
    video = null,
    forceHud = false,
    volume,
    volumeMax,
    onVolumeChange,
    onToggleMute,
    audioBlocked = false,
    onEnableAudio,
    chatOpen = false,
    onToggleChat,
    reaktionenAn,
    onToggleReaktionen,
    queueOpen = false,
    onToggleQueue,
    onDetach,
    detachLabel,
    hideDock = false,
    onHide,
    media,
    overlay,
    stats,
    nameExtra,
    controlsExtra,
    chatPanel,
    chatOverlay,
    queuePanel,
    settingsOpen = false,
    onToggleSettings,
    settingsPanel,
    onTogglePlay,
    spielt = true
  }: TileShellProps = $props();

  const KindIcon = $derived(
    { hq: RocketIcon, screen: MonitorIcon, cam: VideoIcon, party: ClapperboardIcon }[kind]
  );
  const kindIconColor = $derived(
    kind === 'hq' ? 'text-red-400' : kind === 'party' ? 'text-primary' : ''
  );

  let containerEl = $state<HTMLDivElement | null>(null);

  // Mobil wird ein krummer Lautstärke-Wert (z.B. 87, vom Desktop-Regler
  // mitgenommen) AKTIV auf den nächsten 5er pegelt — nicht nur angezeigt.
  // Rundet kaufmännisch (87 → 85, 88 → 90); nach dem Pegeln steht der Wert
  // im Raster und der Effekt beruhigt sich.
  $effect(() => {
    if (!handy || volume === undefined || !onVolumeChange) return;
    if (Number.isInteger(volume / 5)) return;
    onVolumeChange(Math.round(volume / 5) * 5);
  });
  let leftColEl = $state<HTMLDivElement | null>(null);
  // Vollbild hat ZWEI Quellen, und am Telefon ist nur die zweite erreichbar.
  // `docVollbild` = echtes Element-Vollbild über die Fullscreen-API (alles
  // außer iPhone). `eigenesVollbild` = selbst gebaut, weil es dort keine
  // Fullscreen-API für <div> gibt; der frühere Weg (Apples Systemplayer über
  // `webkitEnterFullscreen`) nahm dem Nutzer den getrennten Lautstärkeregler
  // weg — Begründung im Kopf von `stream/fullscreen.ts`.
  let docVollbild = $state(false);
  let eigenesVollbild = $state(false);
  const isFullscreen = $derived(docVollbild || eigenesVollbild);
  // Nur im Vollbild relevant: die Overlay-Leiste fadet nach Inaktivität.
  let hudVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const HUD_HIDE_AFTER_MS = 3000;
  // Reicht die Kachelbreite für alle Controls inline? Sonst kollabiert TileDock
  // in ein ⋯-Menü. Im Vollbild ist die Kachel groß → immer wide.
  let dockWide = $state(true);
  const DOCK_WIDE_MIN = 340;

  // `forceHud` (Ton blockiert) hält die Steuerung am Rechner sichtbar, weil dort
  // der Ton-Knopf in der Leiste sitzt. Im selbst gebauten Vollbild des iPhones
  // (`eigenesVollbild`) hielt es die schwebenden Knöpfe DAUERHAFT auf dem Bild:
  // dort blockiert WebKit die Wiedergabe mit Ton, bis jemand tippt, und das
  // Ausblenden nach `HUD_HIDE_AFTER_MS` griff nie. „Ton freigeben" fadet ohnehin
  // nicht mit (`TileMobilSteuerung`), die Abhilfe bleibt also sichtbar.
  const hudEffective = $derived(hudVisible || (forceHud && !eigenesVollbild));
  const fadeClass = $derived(
    `transition-opacity duration-300 ${hudEffective ? 'opacity-100' : 'pointer-events-none opacity-0'}`
  );
  // Stats-Pille (Diagnose) oben links: im Tile immer sichtbar wenn eingeschaltet,
  // im Vollbild an den Fade gekoppelt.
  const showStats = $derived(!!stats && statsVisible.on && (!isFullscreen || hudEffective));
  // Detach gibt's nicht im Vollbild und nicht auf Mobile.
  const showDetach = $derived(!!onDetach && !isFullscreen && !handy);

  function pokeHud(): void {
    if (!isFullscreen) return;
    hudVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hudVisible = false;
    }, HUD_HIDE_AFTER_MS);
  }

  // Beim Betreten des Vollbilds — echtes wie selbst gebautes — zwei Handgriffe:
  // Vollbild = große Kachel → sofort `wide`, sonst blitzt für einen Frame das
  // ⋯-Menü auf, bevor der ResizeObserver nachzieht; und der Ausblend-Timer der
  // schwebenden Steuerung startet.
  function vollbildBetreten(): void {
    dockWide = true;
    pokeHud();
  }

  function handleCatcherClick(): void {
    // Im Vollbild auf Touch: Tap blendet die schwebende Steuerung ein und
    // startet den Ausblend-Timer neu (kein Toggle mehr — Nutzerwunsch: nach
    // HUD_HIDE_AFTER_MS ohne Tap weg, Tap zeigt sie wieder).
    if (handy && isFullscreen) pokeHud();
  }
  function handleCatcherDblClick(): void {
    if (!handy) toggleFs();
  }

  function toggleFs(): void {
    if (eigenesVollbild) {
      eigenesVollbild = false;
      return;
    }
    if (eigenesVollbildNoetig(containerEl)) {
      eigenesVollbild = true;
      vollbildBetreten();
      return;
    }
    toggleFullscreen(containerEl, video);
  }

  // Mobil-Hüllen: HQ-Kachel quer → Vollbild, hoch → verlassen
  // (`querVollbild.ts`, welche Quelle wann: `querVollbildWache.ts`). Liest
  // `isFullscreen` nur im Ereignis, nicht im Effekt. Verlassen lässt sich das
  // selbst gebaute Vollbild sonst über `toggleFs` — am Telefon der Pfeil oben
  // links, den `TileMobilSteuerung` im Vollbild immer zeigt (`zeigeVollbildAus`).
  const querId = `kachel-${Math.random().toString(36).slice(2)}`;
  $effect(() => {
    if (kind !== 'hq' && kind !== 'party') return;
    return querVollbildBeobachten(querId, {
      eigenes: (an) => {
        eigenesVollbild = an;
        if (an) vollbildBetreten();
      },
      imEigenen: () => eigenesVollbild,
      echt: (an) => (docVollbild = an)
    });
  });
  // Der Lage-Zähler: im Vollbild darf das Gerät drehen (layoutLage lässt die
  // Orientierungs-Sperre los) — sonst „kippt nichts", während das Vollbild
  // hochkant eingefroren wirkt. Gilt für BEIDE Wege ins Vollbild: Kippen
  // (eigenes) und Knopf (echtes Element-Vollbild) — der Knopf-Weg war der
  // zweite Nutzerbefund vom 2026-10-19.
  $effect(() => {
    if (!isFullscreen) return;
    kachelVollbildLage.anmelden();
    return () => kachelVollbildLage.abmelden();
  });

  // Rahmen fällt im Vollbild weg; das selbst gebaute nimmt sich die Fläche
  // selbst (`fixed inset-0`) und ist schwarz wie das echte — sonst schien quer
  // neben dem 16:9-Bild der Seitengrund durch (`bg-bg-chat` ist dunkel fast
  // durchsichtig, das <video> hat am Handy keinen eigenen Grund).
  //
  // `data-eigenes-vollbild` ist der Haken für das Eckfenster: navigiert der
  // Nutzer aus dem Kanal, während das selbst gebaute Vollbild an ist, wird die
  // Kachel vom Hintergrund-Host zum PiP-Fenster — das `fixed inset-0` bliebe
  // aber stehen und deckte den ganzen Bildschirm zu. `app.css` nimmt es im
  // Eckfenster zurück, über denselben Weg wie `data-pip-hide` (die Kachel
  // selbst erfährt nie, ob sie angedockt ist).
  const containerClass = $derived(
    [
      'flex h-full overflow-hidden',
      isFullscreen
        ? 'rounded-none border-0'
        : 'rounded-2xl border border-border handy:rounded-none handy:border-0',
      eigenesVollbild ? 'fixed inset-0 z-40 bg-black' : 'bg-bg-chat'
    ].join(' ')
  );

  const dockProps = $derived({
    kindIcon: KindIcon,
    kindIconColor,
    name,
    nameTestid,
    nameExtra,
    testidPrefix,
    volume,
    volumeMax,
    onVolumeChange,
    onToggleMute,
    audioBlocked,
    onEnableAudio,
    hasStats: !!stats,
    chatOpen,
    onToggleChat,
    reaktionenAn,
    onToggleReaktionen,
    queueOpen,
    onToggleQueue,
    controlsExtra,
    onDetach,
    showDetach,
    detachLabel,
    isFullscreen,
    onToggleFullscreen: toggleFs,
    onHide
  });

  onMount(() => {
    function onFsChange(an: boolean) {
      docVollbild = an;
      if (isFullscreen) {
        vollbildBetreten();
      } else {
        hudVisible = true;
        if (hideTimer) clearTimeout(hideTimer);
      }
    }
    const abVollbild = aufVollbildWechsel(onFsChange);

    let ro: ResizeObserver | null = null;
    if (leftColEl) {
      ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width ?? 0;
        dockWide = w >= DOCK_WIDE_MIN;
      });
      ro.observe(leftColEl);
    }

    return () => {
      abVollbild();
      ro?.disconnect();
      if (hideTimer) clearTimeout(hideTimer);
    };
  });
</script>

<div
  bind:this={containerEl}
  class={containerClass}
  data-testid={containerTestid}
  data-identity={identity}
  data-eigenes-vollbild={eigenesVollbild ? '' : undefined}
>
  <div bind:this={leftColEl} class="flex min-w-0 flex-1 flex-col">
    <div
      class="relative flex min-h-0 flex-1 flex-col"
      onmousemove={pokeHud}
      onpointerdown={() => querKacheln.angetippt(querId)}
      role="presentation"
    >
      {@render media()}
      {@render overlay?.()}

      {#if kind !== 'party'}
        <!-- Transparenter Klick-Fänger über dem Video (nicht über iframes!):
             Doppelklick → Fullscreen (Desktop), Tap → Leiste toggeln nur im
             Vollbild (Mobile). Die Watch-Party (kind 'party') nutzt ein
             iframe — dort würde der Fänger die nativen Controls blockieren. -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div
          class={isFullscreen
            ? 'absolute inset-0 z-20 cursor-pointer'
            : 'absolute inset-0 cursor-pointer'}
          onclick={handleCatcherClick}
          ondblclick={handleCatcherDblClick}
          aria-hidden="true"
          title={isFullscreen ? undefined : m.tile_shell_dblclick_fullscreen()}
        ></div>
      {/if}

      <!-- Mobil: die schwebenden Knöpfe AUF dem Video ersetzen die Leiste
           darunter — in der Kachel wie im Vollbild dieselbe Komponente, im
           Vollbild nur fadend. Der Pfeil „Vollbild verlassen" steht im
           Vollbild immer (`zeigeVollbildAus`): auch das HQ-Vollbild, das
           beim Querdrehen von selbst aufgeht, lässt sich damit schliessen,
           ohne zurückzudrehen. Am Rechner bleiben Dock-Leiste und
           Doppelklick wie bisher. -->
      {#if handy}
        <TileMobilSteuerung
          {testidPrefix}
          {isFullscreen}
          fadeClass={isFullscreen ? fadeClass : ''}
          zeigeVollbildAus={handy}
          {volume}
          {volumeMax}
          {onVolumeChange}
          {onToggleMute}
          {audioBlocked}
          {onEnableAudio}
          {chatOpen}
          {onToggleChat}
          {queueOpen}
          {onToggleQueue}
          {onHide}
          onToggleFullscreen={toggleFs}
          {video}
          settingsOpen={settingsOpen ?? false}
          onToggleSettings={onToggleSettings}
          {onTogglePlay}
          {spielt}
        />
      {/if}

      <!-- Diagnose-Stats oben links — nur wenn global eingeschaltet -->
      {#if showStats}
        <div class="absolute left-2 top-2 {isFullscreen ? fadeClass : ''}">
          {@render stats?.()}
        </div>
      {/if}

      <!-- Vollbild am RECHNER: Leiste als fadendes Overlay über dem unteren
           Bildrand, das nach Inaktivität (HUD_HIDE_AFTER_MS) ausgeblendet
           wird. Am Handy greift stattdessen die neue schwebende Steuerung. -->
      {#if isFullscreen && !hideDock && !handy}
        <div
          class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent pt-10 {fadeClass}"
        >
          <TileDock {...dockProps} overlay wide={dockWide} />
        </div>
      {/if}

      {#if isFullscreen && chatOpen}
        {@render chatOverlay?.()}
      {/if}
      {#if settingsOpen && isFullscreen && handy}
        {@render settingsPanel?.()}
      {/if}
      {#if chatOpen && !isFullscreen && handy}
        <!-- Mobile: Chat als Vollflächen-Overlay statt Seitenpanel. -->
        <div class="absolute inset-0 z-20">
          {@render chatPanel?.()}
        </div>
      {/if}
      {#if settingsOpen && !isFullscreen && handy}
        <!-- Mobile: Einstellungen (z. B. Twitch-Qualität) als Vollflächen-Overlay. -->
        <div class="absolute inset-0 z-20">
          {@render settingsPanel?.()}
        </div>
      {/if}
      {#if queueOpen && !isFullscreen && handy}
        <div class="absolute inset-0 z-20">
          {@render queuePanel?.()}
        </div>
      {/if}
    </div>

    <!-- Solide Steuerleiste UNTER dem Video, nur außerhalb des Vollbilds —
         und am Handy gar nicht: dort steuern die schwebenden Knöpfe (Schließen,
         Vollbild, Lautstärke) das Bild direkt, eine Leiste darunter kostet
         nur Höhe vom Stream. Im Vollbild übernimmt das fadende Overlay. -->
    {#if !isFullscreen && !hideDock && !handy}
      <div class="bg-bg-panel border-t border-border">
        <TileDock {...dockProps} overlay={false} wide={dockWide} />
      </div>
    {/if}
  </div>

  {#if chatOpen && !isFullscreen && !handy}
    {@render chatPanel?.()}
  {/if}
  {#if queueOpen && !isFullscreen && !handy}
    {@render queuePanel?.()}
  {/if}
</div>
