<!--
  Die Ton-Schalter, die es nur in der iOS-App gibt — aus
  `SettingsAudioVideo.svelte` herausgelöst (Grössen-Policy). Android und der
  Browser haben diese Wahl nicht, und ein Schalter, der nichts tut, ist
  schlechter als keiner; deshalb rendert die Komponente ausserhalb der
  iOS-Hülle nichts.

  - Bluetooth-HQ: ein Schalter für den nativen Sprachkanal (`iosFunkHq`),
    nur wenn der Bau ihn trägt (`nativeFunkHqDa`). Den Web-Weg dafür
    (`bluetoothHq`) gibt es nicht mehr (Eigentümer-Entscheid E6); ein früher
    gespeicherter Wert wird einmal übernommen (`platform/iosBluetoothHq.ts`).
  - Volle Tonqualität gibt es nicht mehr (Eigentümer-Entscheid 2026-10-17: es
    gilt Apples Sprachverarbeitung).
  - Diagnose bei Tonausfall: der Opt-out für den automatischen Bericht
    (`diagnose/iosTonDiagnose.ts`) — derselbe Schlüssel wie am Desktop
    (`uploadDiagnosticLogs`, Vorgabe an), dort im Reiter „Experimental", den es
    in der App nicht gibt.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Switch from '$lib/components/form/Switch.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { funkHqSetzen } from '$lib/platform/iosFunkHq';
  import { nativeFunkHqDa } from '$lib/platform/iosSpracheWeiche';
  import { isCapacitorIOS } from '$lib/platform/runtime';
  import { settings } from '$lib/stores/settings.svelte';
  import { loadAll, saveAll } from '$lib/stream/persistence';

  const ios = isCapacitorIOS();
  const funkHqAnbieten = ios && nativeFunkHqDa();
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
  {#if funkHqAnbieten}
    {@render schalter(
      'settings-ios-funk-hq',
      m.settings_audio_ios_funk_hq_label(),
      m.settings_audio_ios_funk_hq_hint(),
      settings.audio.iosFunkHq,
      (v) => {
        settings.setIosFunkHq(v);
        funkHqSetzen(v);
      }
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
