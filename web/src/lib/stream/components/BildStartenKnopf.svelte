<!--
  „Bild starten" auf der Übertragungs-Kachel — nur, wenn WebKit das Bild ohne
  Geste verweigert (`bildStart.ts`: Stromsparmodus oder Wärmedrosselung, und
  die WebView spielt keinen eigenen Ton, weil er in der iOS-Hülle nativ läuft).
  Jede Berührung der Seite startet das Bild ohnehin (`aufGesteAbspielen`); der
  Knopf sagt, dass eine fehlt. Ohne nativen Ton ist `gesperrt` nie gesetzt.
-->
<script lang="ts">
  import PlayIcon from '@lucide/svelte/icons/play';
  import { m } from '$lib/paraglide/messages.js';

  let { gesperrt, onStarten }: { gesperrt: boolean; onStarten: () => void } = $props();
</script>

{#if gesperrt}
  <button
    type="button"
    class="absolute bottom-1/4 left-1/2 z-20 flex min-h-12 -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-5 py-3 text-sm font-medium text-white"
    data-testid="hq-stream-bild-starten"
    onclick={(e) => {
      e.stopPropagation();
      onStarten();
    }}
  >
    <PlayIcon class="size-4 shrink-0" />
    {m.stream_ios_bild_starten()}
  </button>
{/if}
