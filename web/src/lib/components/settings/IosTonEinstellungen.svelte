<!--
  Die Ton-Schalter, die es nur in der iOS-App gibt — aus
  `SettingsAudioVideo.svelte` herausgelöst (Grössen-Policy). Android und der
  Browser haben diese Wahl nicht, und ein Schalter, der nichts tut, ist
  schlechter als keiner; deshalb rendert die Komponente ausserhalb der
  iOS-Hülle nichts.

  - Bluetooth-HQ: Begründung samt Abwägung an der Einstellung `bluetoothHq`
    (`settings-registry/sections/audio.ts`).
  - Volle Tonqualität: ein Vergleichsschalter (Vorgabe aus), nur, wenn der
    App-Bau ihn trägt (`nativeWacheDa`), Begründung an `iosVolleTonqualitaet`.
  - Diagnose bei Tonausfall: der Opt-out für den automatischen Bericht
    (`diagnose/iosTonDiagnose.ts`) — derselbe Schlüssel wie am Desktop
    (`uploadDiagnosticLogs`, Vorgabe an), dort im Reiter „Experimental", den es
    in der App nicht gibt.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Switch from '$lib/components/form/Switch.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { nativeWacheDa } from '$lib/platform/iosSpracheWeiche';
  import { tonHqFunkSetzen } from '$lib/platform/iosTon';
  import { isCapacitorIOS } from '$lib/platform/runtime';
  import { settings } from '$lib/stores/settings.svelte';
  import { loadAll, saveAll } from '$lib/stream/persistence';

  const ios = isCapacitorIOS();
  const wache = ios && nativeWacheDa();
  let diagnoseSenden = $state(true);

  onMount(async () => {
    if (!ios) return;
    diagnoseSenden = (await loadAll()).uploadDiagnosticLogs !== false;
  });
</script>

{#snippet schalter(
  testid: string,
  label: string,
  hinweis: string,
  an: boolean,
  wechsel: (v: boolean) => void
)}
  <label class="flex cursor-pointer flex-col gap-1" data-testid={testid}>
    <span class="flex items-center justify-between gap-3">
      <span class="text-text-base text-sm">{label}</span>
      <Switch checked={an} onCheckedChange={wechsel} />
    </span>
    <span class="text-text-muted text-xs">{hinweis}</span>
  </label>
{/snippet}

{#if ios}
  {@render schalter(
    'settings-bluetooth-hq',
    m.settings_audio_bluetooth_hq_label(),
    m.settings_audio_bluetooth_hq_hint(),
    settings.audio.bluetoothHq,
    (v) => {
      settings.audio.bluetoothHq = v;
      tonHqFunkSetzen(v);
    }
  )}
  {#if wache}
    {@render schalter(
      'settings-ios-volle-tonqualitaet',
      m.settings_audio_ios_volle_ton_label(),
      m.settings_audio_ios_volle_ton_hint(),
      settings.audio.iosVolleTonqualitaet,
      (v) => (settings.audio.iosVolleTonqualitaet = v)
    )}
  {/if}
  {@render schalter(
    'settings-ios-ton-diagnose',
    m.settings_audio_ios_diagnose_label(),
    m.settings_audio_ios_diagnose_hint(),
    diagnoseSenden,
    (v) => {
      diagnoseSenden = v;
      void saveAll({ uploadDiagnosticLogs: v });
    }
  )}
{/if}
