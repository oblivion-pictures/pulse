<!--
  DM-attachment limits. Two numeric inputs + Speichern. Bytes are
  displayed/edited as MB for sanity. Patches the chat-gateway singleton;
  next attachment-upload-url request reads the new value live.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { adminApi, type ChatSettings } from '$lib/api/admin';
  import { bytesToMiB, dmSizeToSave } from './dmLimitFormat';
  import SaveIcon from '@lucide/svelte/icons/save';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let current = $state<ChatSettings | null>(null);
  // number | null: ein geleertes <input type="number"> bindet null.
  let sizeMB = $state<number | null>(0);
  let count = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const cs = await adminApi.getDmLimits();
      current = cs;
      sizeMB = bytesToMiB(cs.dm_attachment_max_size_bytes);
      count = cs.dm_attachment_max_count_per_message;
    } catch (e) {
      error = errText(e);
    }
  });

  // Die Größe geht nur mit, wenn das Feld geändert wurde (s. dmLimitFormat.ts):
  // die Anzeige ist gerundet, der gespeicherte Wert nicht.
  const sizeToSave = $derived(
    current === null ? undefined : dmSizeToSave(sizeMB, current.dm_attachment_max_size_bytes)
  );
  const dirty = $derived(
    current !== null &&
      (sizeToSave !== undefined || count !== current.dm_attachment_max_count_per_message)
  );

  async function save() {
    if (!dirty || busy) return;
    busy = true;
    try {
      const next = await adminApi.patchDmLimits({
        dm_attachment_max_size_bytes: sizeToSave,
        dm_attachment_max_count_per_message: count
      });
      current = next;
      // Anzeige = gespeicherter Wert, auch wenn der Server (oder die
      // Untergrenze) etwas anderes zurückgibt als eingetippt.
      sizeMB = bytesToMiB(next.dm_attachment_max_size_bytes);
      toast.success(m.admin_attachments_limits_updated());
    } catch (e) {
      toast.error(m.admin_attachments_save_failed(), {
        description: errText(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-attachments">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_attachments_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">
      {m.admin_attachments_description()}
    </p>
  </div>

  {#if error}
    <FieldError message={m.admin_attachments_error({ message: error ?? '' })} />
  {:else if current}
    <div class="grid gap-4 nicht-handy:grid-cols-2">
      <label class="flex flex-col gap-1.5">
        <span class="text-text-base text-sm">{m.admin_attachments_max_size_label()}</span>
        <Input
          type="number"
          min="0.001"
          max="4096"
          step="any"
          bind:value={sizeMB}
          data-testid="dm-max-size-input"
        />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-text-base text-sm">{m.admin_attachments_max_count_label()}</span>
        <Input
          type="number"
          min="0"
          max="64"
          step="1"
          bind:value={count}
          data-testid="dm-max-count-input"
        />
      </label>
    </div>

    <div class="mt-4 flex items-center justify-end">
      <Button onclick={save} disabled={!dirty || busy} data-testid="dm-limits-save">
        <SaveIcon class="size-4" />
        {busy ? m.admin_attachments_saving() : m.admin_attachments_save()}
      </Button>
    </div>
  {:else}
    <LoadingState label={m.admin_attachments_loading()} />
  {/if}
</section>
