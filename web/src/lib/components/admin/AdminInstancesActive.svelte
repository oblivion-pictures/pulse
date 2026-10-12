<!--
  Admin: aktive Server (gemietete und Heim-Server, mit Herkunfts-Chip).
  Aktionen: „Sperren“ für alle. „Secret rotieren“ nur bei Einträgen aus der
  Freigabe-Zeit — ein selbst verbundener Eintrag (`ohne_freigabe`, Spec E1)
  trägt stattdessen den Vermerk „ohne Freigabe“: sein Betreiber verbindet bei
  Bedarf neu (`pulse-connect`), und das neue Secret landet dann auf dem Server
  statt in diesem Fenster (Skizze des Eigentümers, 2026-10-10).

  Bis 2026-10 bekamen Heim-Server mit genehmigtem Antrag hier „Freischaltung
  zurücknehmen“ statt „Sperren“ (AdminAppHostRevoke). Mit dem Antrag ist der
  Weg entfallen; „Sperren“ trägt den Teil, der wirkte: der Server landet auf
  der Sperrliste und stellt den Betrieb ein.

  Das rotierte Secret erscheint EINMALIG im Dialog.
-->
<script lang="ts">
  import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import {
    adminInstancesApi,
    type AdminInstance,
    type RotateSecretResult
  } from '$lib/api/instances';
  import RotatedSecretDialog from './RotatedSecretDialog.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
  import ReasonDialog from '$lib/components/feedback/ReasonDialog.svelte';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let instances = $state<AdminInstance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Suspend flow
  let suspendTarget = $state<AdminInstance | null>(null);
  let suspendOpen = $state(false);
  let suspending = $state(false);
  let rotating = $state(false);

  // Rotate flow
  let rotateTarget = $state<AdminInstance | null>(null);
  let rotateResult = $state<RotateSecretResult | null>(null);
  let rotateDialogOpen = $state(false);

  onMount(async () => {
    await reload();
  });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      instances = await adminInstancesApi.listInstances('active');
    } catch (e) {
      loadError = errText(e);
    } finally {
      loading = false;
    }
  }

  function removeInstance(id: string): void {
    instances = instances.filter((i) => i.id !== id);
  }

  async function doSuspend(reason: string) {
    if (!suspendTarget) return;
    suspending = true;
    try {
      await adminInstancesApi.suspendInstance(suspendTarget.id, reason.trim() || undefined);
      removeInstance(suspendTarget.id);
      toast.success(m.admin_instances_active_suspended({ hostname: suspendTarget.hostname }));
      suspendOpen = false;
      suspendTarget = null;
    } catch (e) {
      toast.error(m.admin_instances_active_suspend_failed(), {
        description: errText(e)
      });
    } finally {
      suspending = false;
    }
  }

  // Rotate-Confirm über den gemeinsamen Dienst (statt handgebautem Dialog).
  async function askRotate(inst: AdminInstance) {
    const ok = await confirmDialog({
      title: m.admin_instances_active_rotate_title(),
      description: `${inst.hostname} — ${m.admin_instances_active_rotate_warning()}`,
      confirmLabel: m.admin_instances_active_btn_rotate_confirm(),
      cancelLabel: m.admin_instances_active_btn_cancel()
    });
    if (!ok) return;
    rotateTarget = inst;
    doRotate();
  }

  async function doRotate() {
    // rotating-Guard (wie suspending bei doSuspend): ohne ihn feuert ein
    // Doppelklick auf "Bestätigen" zwei rotateSecret-Calls — der zweite
    // rotiert das gerade angezeigte Secret sofort wieder weg.
    if (!rotateTarget || rotating) return;
    rotating = true;
    busy[rotateTarget.id] = true;
    try {
      rotateResult = await adminInstancesApi.rotateSecret(rotateTarget.id);
      rotateDialogOpen = true;
    } catch (e) {
      toast.error(m.admin_instances_active_rotate_failed(), {
        description: errText(e)
      });
    } finally {
      busy[rotateTarget.id] = false;
      rotating = false;
      rotateTarget = null;
    }
  }

  function onRotateClose() {
    rotateDialogOpen = false;
    rotateResult = null;
  }
</script>

{#if loading}
  <LoadingState label={m.admin_instances_active_loading()} />
{:else if loadError}
  <FieldError message={m.admin_instances_active_load_error({ error: loadError })} />
{:else if instances.length === 0}
  <EmptyState message={m.admin_instances_active_empty()} />
{:else}
  <div class="flex flex-col gap-2">
    {#each instances as inst (inst.id)}
      <div
        class="border-border bg-bg-hover/30 flex flex-col gap-2 rounded-xl border p-3"
        data-testid="active-instance-{inst.id}"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-text-bright text-sm font-medium">{inst.hostname}</p>
            <p class="text-text-muted mt-0.5 text-xs">
              {inst.registrar_username}{#if inst.worker_id_chat !== null}
                · Workers: {inst.worker_id_chat}/{inst.worker_id_voice}/{inst.worker_id_media}{/if}
            </p>
            <p class="text-text-muted text-xs">
              {new Date(inst.registered_at).toLocaleDateString('de-DE')}
            </p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {#if inst.ohne_freigabe}
              <span
                class="border-border text-text-muted rounded-full border px-2 py-0.5 text-xs"
                data-testid="admin-instance-ohne-freigabe"
              >
                {m.admin_instances_ohne_freigabe()}
              </span>
            {/if}
            <span
              class="border-border text-text-muted rounded-full border px-2 py-0.5 text-xs"
              data-testid="admin-instance-origin-chip"
            >
              {inst.origin === 'app_host' ? m.hosting_origin_app() : m.hosting_origin_vps()}
            </span>
            <span class="bg-success/20 text-success rounded-full px-2 py-0.5 text-xs"
              >{m.admin_instances_active_status_active()}</span
            >
          </div>
        </div>
        <div class="flex gap-2">
          {#if !inst.ohne_freigabe}
            <Button
              variant="outline"
              size="xs"
              onclick={() => askRotate(inst)}
              disabled={!!busy[inst.id]}
              data-testid="admin-instance-rotate-{inst.id}"
            >
              {m.admin_instances_active_btn_rotate()}
            </Button>
          {/if}
          <Button
            variant="destructive-solid"
            size="xs"
            onclick={() => {
              suspendTarget = inst;
              suspendOpen = true;
            }}
            disabled={!!busy[inst.id]}
            data-testid="admin-instance-suspend-{inst.id}"
          >
            {m.admin_instances_active_btn_suspend()}
          </Button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Suspend Dialog -->
<ReasonDialog
  bind:open={suspendOpen}
  title={m.admin_instances_active_suspend_title()}
  description={suspendTarget?.hostname}
  label={`${m.admin_instances_active_reason_label()} (${m.admin_instances_active_reason_optional()})`}
  maxlength={500}
  rows={2}
  busy={suspending}
  busyLabel={m.admin_instances_active_suspending()}
  confirmLabel={m.admin_instances_active_btn_suspend()}
  cancelLabel={m.admin_instances_active_btn_cancel()}
  confirmVariant="destructive-solid"
  testId="suspend-dialog"
  onConfirm={doSuspend}
/>

<!-- Neues Secret — kein auto-dismiss! (ausgelagert, Größen-Policy) -->
<RotatedSecretDialog open={rotateDialogOpen} result={rotateResult} onClose={onRotateClose} />
