<script lang="ts">
  /**
   * Ton-Einstellungen der iOS-Hülle. Eigene Seite statt `{#if}`-Inseln in
   * `SettingsAudioVideo.svelte`: dort hängt fast alles am WebKit-Mikrofon und
   * an `setSinkId`, beides in der Hülle ohne Wirkung — den Raum hält die
   * Hülle selbst, Ein- und Ausgabe wählt iOS (Kontrollzentrum, Bluetooth).
   *
   * Es fehlen mit Absicht: Ein-/Ausgabegerät, Pegelanzeige, Gate-Schwelle,
   * Mikro-Verstärkung, Rauschunterdrückung, Echo, Stereo, Raumklang,
   * Push-to-Talk und „Eigenen Ton hören" (Eigentümer-Entscheid 2026-10-18).
   * Vor allem startet diese Seite KEINEN Mikrofontest: er öffnete beim bloßen
   * Betrachten ein WebKit-Mikrofon und die Berechtigungsfrage, obwohl nichts
   * davon gebraucht wird (Begründung zum Konflikt mit der Hülle:
   * `platform/mikrofonBeiDerHuelle.ts`).
   *
   * Bleiben: Ausgabelautstärke, Limiter, Bluetooth-HQ, Diagnose.
   */
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import IosTonEinstellungen from './IosTonEinstellungen.svelte';
  import OutputVolumeControl from './OutputVolumeControl.svelte';
</script>

<div class="flex flex-col gap-6" data-testid="settings-audio-video-panel">
  <div class="border-border bg-bg-input/40 flex flex-col gap-4 rounded-2xl border p-4">
    <OutputVolumeControl />

    <label
      class="flex cursor-pointer items-center justify-between gap-3"
      data-testid="settings-limiter"
    >
      <span class="text-text-base text-sm">{m.settings_audio_video_limiter_label()}</span>
      <Checkbox
        checked={settings.audio.limiterEnabled}
        onchange={(e) => {
          const on = (e.currentTarget as HTMLInputElement).checked;
          settings.setLimiterEnabled(on);
          voice.setLimiterEnabled(on);
        }}
      />
    </label>

    <IosTonEinstellungen />
  </div>
</div>
