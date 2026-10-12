<!--
  Admin: Gesperrte Self-Host-Instanzen + Entsperren-Aktion.

  Eine Zeile mit status 'deleted' ist eine gesperrte Instanz, die der Besitzer
  gelöscht hat: sie hält ihre Adresse weiter gesperrt (Backend:
  geloeschte_adresse.py). Es gibt nichts zu entsperren, nur die Adresse
  freizugeben — dieselbe Route, eigene Beschriftung und Meldung.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminInstancesApi, type AdminInstance } from '$lib/api/instances';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import { Button } from '$lib/components/ui/button';

  let instances = $state<AdminInstance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  onMount(async () => { await reload(); });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      // Alle Herkünfte. Gesperrte Heim-Server waren hier bis 2026-10
      // ausgefiltert, mit Verweis auf einen Antrags-Reiter, den es nicht mehr
      // gibt — sie waren damit nirgends zu sehen und nicht zu entsperren.
      instances = await adminInstancesApi.listInstances('suspended');
    } catch (e) {
      loadError = errText(e);
    } finally {
      loading = false;
    }
  }

  async function unsuspend(inst: AdminInstance) {
    const released = inst.status === 'deleted';
    busy[inst.id] = true;
    try {
      await adminInstancesApi.unsuspendInstance(inst.id);
      instances = instances.filter((i) => i.id !== inst.id);
      toast.success(
        released
          ? m.admin_instances_suspended_release_success({ hostname: inst.hostname })
          : m.admin_instances_suspended_unsuspend_success({ hostname: inst.hostname })
      );
    } catch (e) {
      toast.error(
        released
          ? m.admin_instances_suspended_release_failed()
          : m.admin_instances_suspended_unsuspend_failed(),
        { description: errText(e) }
      );
    } finally {
      busy[inst.id] = false;
    }
  }
</script>

{#if loading}
  <LoadingState label={m.admin_instances_suspended_loading()} />
{:else if loadError}
  <FieldError message={m.admin_instances_suspended_load_error({ error: loadError })} />
{:else if instances.length === 0}
  <EmptyState message={m.admin_instances_suspended_empty()} />
{:else}
  <div class="flex flex-col gap-2">
    {#each instances as inst (inst.id)}
      {@const deleted = inst.status === 'deleted'}
      <div class="border-border bg-bg-hover/30 rounded-xl border p-3 flex items-start justify-between gap-3"
           data-testid="suspended-instance-{inst.id}">
        <div class="min-w-0">
          <p class="text-text-bright text-sm font-medium">{inst.hostname}</p>
          <p class="text-text-muted text-xs mt-0.5">
            {inst.registrar_username} · {new Date(inst.registered_at).toLocaleDateString('de-DE')}
          </p>
          {#if deleted}
            <p class="text-warning text-xs mt-1" data-testid="suspended-instance-deleted-note-{inst.id}">
              {m.admin_instances_suspended_deleted_note()}
            </p>
          {/if}
        </div>
        <Button
          variant="success-solid"
          size="xs"
          class="shrink-0"
          onclick={() => void unsuspend(inst)}
          disabled={!!busy[inst.id]}
        >
          {#if deleted}
            {busy[inst.id] ? m.admin_instances_suspended_releasing() : m.admin_instances_suspended_release_button()}
          {:else}
            {busy[inst.id] ? m.admin_instances_suspended_unsuspending() : m.admin_instances_suspended_unsuspend_button()}
          {/if}
        </Button>
      </div>
    {/each}
  </div>
{/if}
