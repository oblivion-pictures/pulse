<!--
  „Mikrofon ausgefallen – Erneut verbinden" (nur iOS-nativ).

  Der Mikrofon-Wächter der Hülle (`SpracheMikroWache.swift`) hat alle Stufen
  versucht, und das Mikrofon liefert weiter nichts. Bis zum 2026-10-17 sah man
  davon nichts: das Zeichen blieb auf „offen", gehört wurde niemand, und nur
  ein App-Neustart half. Der Knopf baut den Kanal neu auf
  (`nativerRaum.svelte.ts::neuVerbinden`). Dasselbe Band zeigt die native
  Kanalansicht, solange sie über dieser Leiste liegt.

  Ausserhalb von iOS ist `voice.nativMikroTot` immer `false`.
-->
<script lang="ts">
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import { voice } from '$lib/voice/livekit.svelte';

  let laeuft = $state(false);

  async function neu(): Promise<void> {
    if (laeuft) return;
    laeuft = true;
    try {
      await voice.nativNeuVerbinden();
    } finally {
      laeuft = false;
    }
  }
</script>

{#if voice.nativMikroTot}
  <div
    class="border-destructive/40 bg-destructive/10 text-destructive mx-1 mb-1.5 flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm"
    role="alert"
    data-testid="voice-mikro-tot"
  >
    <MicOffIcon class="size-4 shrink-0" />
    <span class="min-w-0 flex-1 truncate">{m.voice_mikro_tot_text()}</span>
    <Button size="sm" variant="destructive" disabled={laeuft} onclick={neu}>
      {m.voice_mikro_tot_neu()}
    </Button>
  </div>
{/if}
