<!--
  TileMobilSteuerung — die schwebenden Bedienelemente einer Video-Kachel am
  Handy. Sie ERSETZEN dort die Leiste `TileDock`, die unter dem Bild zu viel
  Höhe kosten würde.

  **Ersetzen heisst: alles, was der Dock kann, muss hier erreichbar sein.**
  Die erste Fassung liess nur Schliessen, Vollbild und Lautstärke übrig — mit
  dem Rest verschwanden am Telefon auch der Stream-Chat, die Watch-Party-
  Warteschlange, die Stummschaltung und der Knopf „Ton freischalten". Der war
  der schlimmste Verlust: blockiert Chromium die Wiedergabe, ist er die einzige
  Abhilfe, und ohne ihn bleibt der Stream für immer stumm.

  **Die vier Ecken halten seit dem 2026-10-08 Abstand zur Aussparung**
  (`--safe-left`/`--safe-right`, angelegt mit dieser Änderung). Vorher stand
  dort nur `left-2`/`right-2`, und das genügte, solange die iOS-Hülle auf
  Hochformat gelockt war — im Hochformat sind links und rechts null. Mit dem
  Querformat fürs Stream-Vollbild (Punkt 27) wandert die Aussparung an eine
  Seite, und genau dort sitzen Schliessen, Lautstärke und Vollbild-Ausstieg.
  Seitlich entfällt es nur in der KACHEL der iOS-Hülle: dort hat die Shell die
  Aussparung schon abgezogen (sonst stünde sie doppelt, `seiteLinks`).
  Oben und unten gilt `top-2`/`bottom-2` nur in der KACHEL (sie liegt nicht am
  Bildrand). Im selbst gebauten Vollbild (`TileShell`, `fixed inset-0`) liegen
  die Knöpfe AM Bildrand: im Hochformat unter der Dynamic Island und über dem
  Home-Balken, im Querformat über dem Home-Balken — dort setzen
  `--safe-top`/`--safe-bottom` den Abstand, aber nur in der iOS-Hülle
  (`ios:`-Variante), Android und Browser behalten ihre Lage.

  Eine Komponente für beide Lagen (Kachel und Vollbild) statt zweier Zweige:
  die Knöpfe sind dieselben, nur das Ausblenden nach Ruhe (`fadeClass`) und der
  Vollbild-Ausstieg unterscheiden sich.
-->
<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import PauseIcon from '@lucide/svelte/icons/pause';
  import PlayIcon from '@lucide/svelte/icons/play';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinusIcon from '@lucide/svelte/icons/minus';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import ListVideoIcon from '@lucide/svelte/icons/list-video';
  import { m } from '$lib/paraglide/messages.js';
  import { isCapacitorIOS } from '$lib/platform/runtime';
  import BildImBildKnopf from '$lib/stream/components/BildImBildKnopf.svelte';

  let {
    testidPrefix,
    isFullscreen = false,
    /** Ausblend-Klasse im Vollbild; in der Kachel leer (nichts fadet). */
    fadeClass = '',
    /** Vollbild-Ausstieg als Pfeil oben links. Im Querformat ist das Vollbild
     *  automatisch und wird automatisch verlassen — dort bewusst aus. */
    zeigeVollbildAus = false,
    volume,
    volumeMax,
    onVolumeChange,
    onToggleMute,
    audioBlocked = false,
    onEnableAudio,
    chatOpen = false,
    onToggleChat,
    queueOpen = false,
    onToggleQueue,
    onHide,
    onToggleFullscreen,
    /** Das Video der Kachel — für das System-Bild-in-Bild. */
    video = null,
    /** Einstellungs-Sheet der Kachel (z. B. Twitch-Qualität) — ohne den Prop
     *  bleibt der Zahnrad-Knopf weg. */
    settingsOpen = false,
    onToggleSettings,
    /** Wiedergabe umschalten (Watch-Party) — ohne den Prop bleibt der
     *  Play/Pause-Knopf weg. */
    onTogglePlay,
    spielt = true
  }: {
    testidPrefix: string;
    isFullscreen?: boolean;
    fadeClass?: string;
    zeigeVollbildAus?: boolean;
    volume?: number;
    volumeMax?: number;
    onVolumeChange?: (e: Event | number) => void;
    onToggleMute?: () => void;
    audioBlocked?: boolean;
    onEnableAudio?: () => void;
    chatOpen?: boolean;
    onToggleChat?: () => void;
    queueOpen?: boolean;
    onToggleQueue?: () => void;
    onHide?: () => void;
    onToggleFullscreen: () => void;
    video?: HTMLVideoElement | null;
    settingsOpen?: boolean;
    onToggleSettings?: () => void;
    onTogglePlay?: () => void;
    spielt?: boolean;
  } = $props();

  // Am Handy wird die Lautstärke IMMER auf 5er gerastert — angezeigt UND
  // gesetzt: ein Wert wie 87 (vom Regler des Rechners mitgenommen) zeigt hier
  // 85, der nächste Tipp geht auf 90.
  const gerastert = $derived(volume === undefined ? 0 : Math.round(volume / 5) * 5);
  const hatLautstaerke = $derived(onVolumeChange !== undefined && volume !== undefined);

  // Im Vollbild halten die Knöpfe Abstand zur Aussparung (nur iOS-Hülle).
  const obenKlasse = $derived(isFullscreen ? 'ios:top-[calc(0.5rem+var(--safe-top))]' : '');
  const untenKlasse = $derived(isFullscreen ? 'ios:bottom-[calc(0.5rem+var(--safe-bottom))]' : '');

  // Nur in der iOS-HÜLLE hat die Shell die seitliche Aussparung außerhalb des
  // Vollbilds schon abgezogen (`routes/app/+layout.svelte`:
  // `ios:handy:pl/pr-[var(--safe-…)]`) — ein zweites Mal stünde der Abstand
  // doppelt. Im selbst gebauten Vollbild (`fixed inset-0`) und überall sonst
  // gilt es wie bisher.
  const seitenAbzug = $derived(!isFullscreen && isCapacitorIOS());
  const seiteLinks = $derived(seitenAbzug ? '0px' : 'var(--safe-left)');
  const seiteRechts = $derived(seitenAbzug ? '0px' : 'var(--safe-right)');
  // 44 pt (`size-11`): die Mindestfläche, die Apple und Material für einen
  // Finger nennen. Vorher 40 pt, die Lautstärke-Knöpfe 36 pt.
  const RUND =
    'flex size-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65';
</script>

<!-- Oben links: X — eine Ebene zurück, und die Ebenen sind: Einstellungen
     offen ⇒ nur das Rad schliessen (Nutzerbefund 2026-10-19: das X machte
     die ganze Party zu, statt aus dem Rad heraus); sonst Vollbild verlassen
     bzw. Kachel schliessen. Im Vollbild wird der Knopf NICHT mit dem HUD
     gefadet — er ist der Nothausgang (Nutzerbefund 2026-10-19: in der
     Watch-Party mit Twitch-Quelle fraß der Zuschauer-Klick-Fänger die
     HUD-Taps auf und ohne HUD blieb der Fadem unbenutzbar ⇒ „komme aus dem
     Vollbild nicht raus“). -->
{#if isFullscreen ? zeigeVollbildAus || settingsOpen : !!onHide || settingsOpen}
  <button
    type="button"
    class="absolute top-2 z-30 {RUND} {obenKlasse} {settingsOpen
      ? ''
      : isFullscreen && zeigeVollbildAus
        ? ''
        : fadeClass}"
    style="left: calc(0.5rem + {seiteLinks})"
    onclick={() => {
      if (settingsOpen) {
        onToggleSettings?.();
        return;
      }
      if (isFullscreen) onToggleFullscreen();
      else onHide?.();
    }}
    aria-label={settingsOpen
      ? m.tile_shell_settings_close()
      : isFullscreen
        ? m.tile_shell_fullscreen_exit()
        : m.tile_shell_hide_tile()}
    data-pip-hide
    data-testid={
      settingsOpen
        ? `${testidPrefix}-settings-exit-float`
        : isFullscreen
          ? `${testidPrefix}-fullscreen-exit-float`
          : `${testidPrefix}-close-float`
    }
  >
    <XIcon class="size-5" />
  </button>
{/if}

<!-- Oben rechts: die Seitenpanel-Schalter. Sie sind die einzige Möglichkeit,
     die Overlays für Chat und Warteschlange am Telefon zu öffnen — ohne sie
     ist deren Markup toter Code. Davor das System-Bild-in-Bild, das sich
     selbst ausblendet, wo es nicht trägt. -->
{#if onToggleChat || onToggleQueue || video}
  <div
    class="absolute top-2 z-30 flex items-center gap-2 {obenKlasse} {fadeClass}"
    style="right: calc(0.5rem + {seiteRechts})"
  >
    <BildImBildKnopf {video} klasse={RUND} pipHide testid={`${testidPrefix}-pip-float`} />
    {#if onToggleQueue}
      <button
        type="button"
        class="{RUND} {queueOpen ? '!text-primary' : ''}"
        onclick={onToggleQueue}
        aria-label={queueOpen ? m.watch_queue_close() : m.watch_queue_open()}
        data-pip-hide
        data-testid={`${testidPrefix}-queue-float`}
      >
        <ListVideoIcon class="size-5" />
      </button>
    {/if}
    {#if onToggleChat}
      <button
        type="button"
        class="{RUND} {chatOpen ? '!text-primary' : ''}"
        onclick={onToggleChat}
        aria-label={chatOpen ? m.tile_shell_chat_close() : m.tile_shell_chat_open()}
        data-pip-hide
        data-testid={`${testidPrefix}-chat-float`}
      >
        <MessageSquareIcon class="size-5" />
      </button>
    {/if}
  </div>
{/if}

<!-- Unten rechts: Play/Pause, Einstellungen (Zahnrad, Nutzerwunsch
     2026-10-19: „neben dem Vollbild") und Vollbild — ein Cluster, ein
     Abstand. Im Vollbild selbst führt der Pfeil oben links hinaus, hier
     bleibt der Vollbild-Knopf ohne Aufgabe; Play und Zahnrad zeigen dann
     weiter (faden mit dem HUD, der Klick-Fänger im Vollbild lässt die Taps
     auf die Fläche kommen). -->
{#if onTogglePlay || onToggleSettings || !isFullscreen}
  <div
    class="absolute bottom-2 z-20 flex items-center gap-2 {untenKlasse} {fadeClass}"
    style="right: calc(0.5rem + {seiteRechts})"
  >
    {#if onTogglePlay}
      <button
        type="button"
        class="{RUND}"
        onclick={onTogglePlay}
        aria-label={spielt ? m.tile_shell_pause() : m.tile_shell_play()}
        data-pip-hide
        data-testid={`${testidPrefix}-play-float`}
      >
        {#if spielt}
          <PauseIcon class="size-5" />
        {:else}
          <PlayIcon class="size-5" />
        {/if}
      </button>
    {/if}
    {#if onToggleSettings}
      <button
        type="button"
        class="{RUND} {settingsOpen ? '!text-primary' : ''}"
        onclick={onToggleSettings}
        aria-label={settingsOpen ? m.tile_shell_settings_close() : m.tile_shell_settings_open()}
        data-pip-hide
        data-testid={`${testidPrefix}-settings-float`}
      >
        <SettingsIcon class="size-5" />
      </button>
    {/if}
    {#if !isFullscreen}
      <button
        type="button"
        class="{RUND}"
        onclick={onToggleFullscreen}
        aria-label={m.tile_shell_fullscreen_enter()}
        data-pip-hide
        data-testid={`${testidPrefix}-fullscreen-float`}
      >
        <MaximizeIcon class="size-5" />
      </button>
    {/if}
  </div>
{/if}

<!-- Mitte: großes Play, solange pausiert — der auffällige Weg zurück in die
     Wiedergabe (Nutzerwunsch 2026-10-19: „in der Mitte und unten rechts Play
     klicken"). Fadet NICHT: ein pausiertes Bild ohne Angebot bleibt pausiert. -->
{#if !spielt && onTogglePlay}
  <button
    type="button"
    class="absolute top-1/2 left-1/2 z-40 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
    onclick={onTogglePlay}
    aria-label={m.tile_shell_play()}
    data-pip-hide
    data-testid={`${testidPrefix}-play-center`}
  >
    <PlayIcon class="size-8" />
  </button>
{/if}

<!-- Unten links: Lautstärke in 5er-Schritten statt Regler — ein ferner Daumen
     trifft zwei Knöpfe sicherer als einen Schieber. Die Stummschaltung sitzt
     als Lautsprecher IN der Pille: sie ist der einzige Weg zurück, wenn man
     die Lautstärke auf 0 gezogen hat. -->
{#if hatLautstaerke}
  <div
    class="absolute bottom-2 z-30 {untenKlasse} {fadeClass}"
    style="left: calc(0.5rem + {seiteLinks})"
  >
    <div
      class="flex items-center gap-0.5 rounded-full bg-black/45 px-1 text-white backdrop-blur-sm"
      data-pip-hide
      data-testid={`${testidPrefix}-volume-stepper`}
    >
      {#if onToggleMute}
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-full transition-colors hover:bg-black/65"
          onclick={onToggleMute}
          aria-label={gerastert === 0 ? m.tile_shell_unmute() : m.tile_shell_mute()}
          data-testid={`${testidPrefix}-mute-float`}
        >
          {#if gerastert === 0}
            <VolumeXIcon class="size-4" />
          {:else}
            <Volume2Icon class="size-4" />
          {/if}
        </button>
      {/if}
      <button
        type="button"
        class="flex size-11 items-center justify-center rounded-full transition-colors hover:bg-black/65"
        onclick={() => onVolumeChange?.(Math.max(0, gerastert - 5))}
        aria-label={m.tile_shell_volume_down()}
        data-testid={`${testidPrefix}-volume-down`}
      >
        <MinusIcon class="size-4" />
      </button>
      <span
        class="w-10 text-center font-mono text-xs tabular-nums"
        data-testid={`${testidPrefix}-volume-value`}>{gerastert}%</span
      >
      <button
        type="button"
        class="flex size-11 items-center justify-center rounded-full transition-colors hover:bg-black/65"
        onclick={() => onVolumeChange?.(Math.min(volumeMax ?? 200, gerastert + 5))}
        aria-label={m.tile_shell_volume_up()}
        data-testid={`${testidPrefix}-volume-up`}
      >
        <PlusIcon class="size-4" />
      </button>
    </div>
  </div>
{/if}

<!-- Ton freigeben: Chromium blockt die Wiedergabe ohne Nutzergeste. Der Knopf
     steht MITTIG und fadet NICHT mit — er ist kein Komfort, sondern die
     einzige Abhilfe, und ein ausgeblendeter Knopf wäre so gut wie keiner. -->
{#if audioBlocked && onEnableAudio}
  <button
    type="button"
    class="absolute top-1/2 left-1/2 z-40 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-black/70 px-4 py-2.5 text-sm font-semibold text-white backdrop-blur-sm transition-colors hover:bg-black/85"
    onclick={onEnableAudio}
    data-pip-hide
    data-testid={`${testidPrefix}-enable-audio-float`}
  >
    <VolumeXIcon class="size-4" />
    {m.tile_shell_enable_audio()}
  </button>
{/if}
