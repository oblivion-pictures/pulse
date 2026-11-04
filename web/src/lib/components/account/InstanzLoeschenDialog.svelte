<!--
  Lösch-Bestätigung für „Meine Server“ (aus `MyInstances.svelte` gezogen).

  Verlangt das Kontopasswort (Sicherheitsfund 2026-11-04): die Cloud löscht
  einen Server nur noch, wenn der Aufrufer es nennt — ein gestohlenes
  Sitzungs-Cookie allein reicht nicht. Ein falsches Passwort (401) lässt den
  Dialog offen und zeigt den Hinweis; jeder andere Fehler schließt ihn mit
  einem Toast wie bisher. Das Feld wird beim Schließen geleert.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import { ApiError } from '$lib/api/client';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';

  let {
    open = $bindable(false),
    ziel,
    onGeloescht
  }: {
    open?: boolean;
    ziel: Instance | null;
    onGeloescht: (id: string) => void;
  } = $props();

  let password = $state('');
  let deleting = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!open) {
      password = '';
      error = null;
    }
  });

  /** „Die Adresse wird wieder frei“ stimmt nicht für einen gesperrten Server:
   *  löscht man ihn, bleibt die Adresse gesperrt (Backend: geloeschte_adresse.py). */
  function deleteText(inst: Instance | null): string {
    const hostname = inst?.hostname ?? '';
    if (inst?.origin === 'app_host') return m.my_instances_apphost_delete_description();
    return inst?.status === 'suspended'
      ? m.eigener_server_loeschen_text_gesperrt({ hostname })
      : m.eigener_server_loeschen_text({ hostname });
  }

  async function confirmDelete() {
    if (!ziel || deleting) return;
    if (!password) {
      error = m.my_instances_delete_password_required();
      return;
    }
    deleting = true;
    error = null;
    const id = ziel.id;
    try {
      await instancesApi.deleteMyInstance(id, password);
      onGeloescht(id);
      toast.success(m.my_instances_delete_success());
      open = false;
    } catch (err) {
      // Nur DIESES 401 heißt „Passwort falsch“; eine tote Sitzung meldet anderes.
      if (err instanceof ApiError && err.status === 401 && err.message === 'invalid credentials') {
        password = '';
        error = m.my_instances_delete_password_wrong();
        return;
      }
      toast.error(m.my_instances_delete_error());
      open = false;
    } finally {
      deleting = false;
    }
  }
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content data-testid="instance-delete-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.my_instances_delete_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {deleteText(ziel)}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <form
      class="space-y-3"
      onsubmit={(e) => {
        e.preventDefault();
        void confirmDelete();
      }}
    >
      <div class="space-y-1.5">
        <FieldLabel
          for="instance-delete-password"
          required
          class="text-text-muted text-xs font-semibold uppercase"
        >
          {m.my_instances_delete_password_label()}
        </FieldLabel>
        <Input
          id="instance-delete-password"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          required
          data-testid="instance-delete-password"
        />
      </div>
      {#if error}
        <Alert.Root variant="destructive" data-testid="instance-delete-error">
          <OctagonXIcon />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}
    </form>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.my_instances_delete_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={confirmDelete}
        disabled={deleting}
        data-testid="instance-delete-confirm"
      >
        {m.my_instances_delete_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
