<script lang="ts">
  // Push-to-Talk in den Ton-Einstellungen: Schalter und die Taste, die beim
  // nächsten Druck übernommen wird.
  import { settings } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { Button } from '$lib/components/ui/button';
  import { onDestroy } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';

  let listeningForPttKey = $state(false);
  let pttKeyListener: ((e: KeyboardEvent) => void) | null = null;

  function startPttCapture() {
    // Doppel-Klick ohne zwischenzeitlichen Tastendruck: den alten Listener
    // ZUERST entfernen, sonst überschreibt Zeile darunter pttKeyListener und
    // der alte Closure bleibt im Capture-Phase registriert — schluckt dann
    // jeden weiteren keydown (preventDefault/stopPropagation) bis Reload.
    if (pttKeyListener) {
      window.removeEventListener('keydown', pttKeyListener, true);
      pttKeyListener = null;
    }
    listeningForPttKey = true;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      settings.setPttKey(e.key);
      listeningForPttKey = false;
      // handler direkt entfernen (nicht über die mutable Variable, die schon
      // auf einen neueren Closure zeigen könnte).
      window.removeEventListener('keydown', handler, true);
      pttKeyListener = null;
    };
    pttKeyListener = handler;
    window.addEventListener('keydown', handler, true);
  }

  onDestroy(() => {
    if (pttKeyListener) {
      window.removeEventListener('keydown', pttKeyListener, true);
      pttKeyListener = null;
    }
  });
</script>

<div class="border-border bg-bg-input/40 flex flex-col gap-4 rounded-2xl border p-4">
  <label class="flex cursor-pointer items-center justify-between gap-3">
    <span class="text-text-base text-sm">{m.settings_audio_video_ptt_enable()}</span>
    <Checkbox
      checked={settings.voice.pttMode}
      onchange={(e) => void voice.setPttMode((e.currentTarget as HTMLInputElement).checked)}
      data-testid="settings-ptt-toggle"
    />
  </label>
  <div class="flex items-center justify-between gap-3">
    <span class="text-text-base text-sm">{m.settings_audio_video_ptt_key_label()}</span>
    <Button
      variant="secondary"
      size="sm"
      onclick={startPttCapture}
      class="uppercase"
      data-testid="settings-ptt-key"
    >
      {listeningForPttKey ? m.settings_audio_video_ptt_press_key() : settings.voice.pttKey}
    </Button>
  </div>
</div>
