<script lang="ts">
  // Die Tafeln, die statt des Kanal-Chats erscheinen, wenn er sich nicht
  // zeigen lässt: Community stillgelegt, Host-Rechner aus, Laden gescheitert.
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m as pm } from '$lib/paraglide/messages.js';

  interface Props {
    art: 'gesperrt' | 'schlaeft' | 'fehler';
    fehler?: string;
    onRetry?: () => void;
  }

  let { art, fehler = '', onRetry }: Props = $props();
</script>

{#if art === 'gesperrt'}
  <section
    class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-none p-8 text-center nicht-handy:rounded-2xl"
    data-testid="community-suspended"
  >
    <h2 class="text-text-bright text-lg font-semibold">{pm.community_suspended_title()}</h2>
    <p class="text-text-muted max-w-sm text-sm">{pm.community_suspended_body()}</p>
  </section>
{:else if art === 'schlaeft'}
  <!-- App-Hosting (2026-10-03): Der Host-Rechner dieser Community ist aus —
       der Normalzustand eines App-Host-Servers, kein Fehlerfall. Verständliche
       Tafel statt technischem Fehlertext; Retry misst die Anwesenheit frisch. -->
  <section
    class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-none p-8 text-center nicht-handy:rounded-2xl"
    data-testid="server-schlaeft"
  >
    <h2 class="text-text-bright text-lg font-semibold">{pm.server_schlaeft_seite_titel()}</h2>
    <p class="text-text-muted max-w-sm text-sm">{pm.server_schlaeft_seite_text()}</p>
    <Button onclick={() => onRetry?.()} data-testid="load-retry">{pm.channel_page_retry()}</Button>
  </section>
{:else}
  <section class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 nicht-handy:rounded-2xl">
    <FieldError message={fehler} testId="load-error" />
    <Button onclick={() => onRetry?.()} data-testid="load-retry">{pm.channel_page_retry()}</Button>
  </section>
{/if}
