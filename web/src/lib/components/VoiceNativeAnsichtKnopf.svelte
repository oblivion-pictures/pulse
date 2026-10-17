<!--
  Der Knopf in der Kachelansicht, der die native Kanalansicht öffnet (nur
  iOS-Hülle mit nativem Raum; ausserhalb ist `voice.nativ` immer `false`).

  **Warum es ihn gibt (seit 2026-10-17):** ein Beitritt öffnet die native
  Ansicht nicht mehr von selbst, nur noch eine laufende Kamera
  (`voice/kameraAnsicht.ts`). Ohne Kamera bleibt man in dieser Kachelansicht —
  und braucht einen sichtbaren Weg in die Ansicht, nicht nur den kleinen Griff
  in der Leiste (`VoiceNativeAnsichtGriff.svelte`). Mikrofon, Push-to-Talk und
  Auflegen bleiben in der Leiste darunter.

  Trefferfläche 48 px hoch (`h-12`, gemessen in `mobile-treffflaechen.spec.ts`).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
  import { m } from '$lib/paraglide/messages.js';
  import { voice } from '$lib/voice/livekit.svelte';
</script>

{#if voice.nativ && !voice.nativeAnsichtOffen}
  <Button
    variant="secondary"
    class="h-12 gap-2 rounded-full px-5"
    onclick={() => voice.ansichtOeffnen()}
    data-testid="voice-native-view-open-tiles"
  >
    <Maximize2Icon class="size-5" />
    {m.voice_native_view_open_btn()}
  </Button>
{/if}
