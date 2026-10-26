<script lang="ts">
  /**
   * Sperrbildschirm „Nutzungsbedingungen": ein Konto, das der aktuellen
   * Fassung nicht zugestimmt hat (alle Konten von vor 2026-10-26, und jedes
   * nach einer AGB-Änderung), kommt nicht in `/app` — dieselbe Mechanik wie
   * `/verify-email-required`. Begründung in `services/auth/src/dcc_auth/agb.py`.
   *
   * Wer nicht zustimmen will, meldet sich ab oder löscht sein Konto direkt
   * hier (AGB Ziffer 10 verspricht das; die Einstellungen liegen hinter der
   * Sperre).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { agbZustimmen, me } from '$lib/api/auth';
  import { ApiError } from '$lib/api/client';
  import { auth } from '$lib/stores/auth.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import AuthCard from '$lib/components/AuthCard.svelte';
  import AgbHaekchen from '$lib/components/auth/AgbHaekchen.svelte';
  import DeleteAccountDialog from '$lib/components/settings/DeleteAccountDialog.svelte';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let ready = $state(false);
  let akzeptiert = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let loeschenOffen = $state(false);

  onMount(async () => {
    await auth.hydrate();
    if (!auth.isAuthenticated) {
      await goto('/login', { replaceState: true });
      return;
    }
    if (!auth.user?.agb_zustimmung_noetig) {
      await goto('/app', { replaceState: true });
      return;
    }
    ready = true;
  });

  async function zustimmen() {
    const fassung = auth.user?.agb_fassung_aktuell;
    if (busy || !akzeptiert || !fassung) return;
    busy = true;
    error = null;
    try {
      await agbZustimmen(fassung);
      await auth.setUser(await me());
      await goto('/app', { replaceState: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Die AGB haben sich seit dem Laden geändert: neue Fassung holen,
        // Häkchen zurücksetzen — zugestimmt wird nur dem, was angezeigt wurde.
        await auth.setUser(await me());
        akzeptiert = false;
        error = m.agb_zustimmung_fehler_veraltet();
      } else {
        error = (err as Error).message;
      }
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard
  headline={m.agb_zustimmung_brand_headline()}
  description={m.agb_zustimmung_brand_description()}
  features={[m.agb_zustimmung_brand_feature_tab(), m.agb_zustimmung_brand_feature_wahl()]}
>
  {#if !ready}
    <LoadingState density="page" />
  {:else}
    <div
      class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 text-center shadow-2xl"
      data-testid="agb-zustimmung-card"
    >
      <div class="bg-bg-input mx-auto flex size-14 items-center justify-center rounded-full">
        <FileTextIcon class="text-primary size-7" />
      </div>
      <h1 class="text-card-foreground text-2xl font-semibold">{m.agb_zustimmung_titel()}</h1>
      <p class="text-muted-foreground text-sm">{m.agb_zustimmung_text()}</p>

      <AgbHaekchen bind:checked={akzeptiert} testid="agb-zustimmung-haekchen" />

      {#if error}
        <Alert.Root variant="destructive" data-testid="agb-zustimmung-fehler">
          <OctagonXIcon />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}

      <Button
        class="w-full"
        onclick={zustimmen}
        disabled={busy || !akzeptiert}
        data-testid="agb-zustimmung-weiter"
      >
        {m.agb_zustimmung_weiter()}
      </Button>

      <p class="text-muted-foreground text-xs">{m.agb_zustimmung_ablehnen_hinweis()}</p>
      <div class="flex justify-center gap-4">
        <Button variant="link" size="xs" onclick={() => auth.signOut()} data-testid="agb-zustimmung-abmelden">
          {m.agb_zustimmung_abmelden()}
        </Button>
        <Button variant="link" size="xs" onclick={() => (loeschenOffen = true)} data-testid="agb-zustimmung-loeschen">
          {m.agb_zustimmung_konto_loeschen()}
        </Button>
      </div>
    </div>
    <DeleteAccountDialog bind:open={loeschenOffen} />
  {/if}
</AuthCard>
