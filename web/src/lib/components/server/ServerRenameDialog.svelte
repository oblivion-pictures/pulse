<!--
  Server umbenennen — der Betreiber (oder ein Admin) gibt seinem Self-Host einen
  Namen, den ALLE Mitglieder statt der Adresse sehen.

  Geöffnet per Rechtsklick auf den Server in der Leiste (`GuildRail`) bzw. per
  Tipp auf die Server-Zeile im Räume-Bereich am Handy (`/app/rooms`) — dieselbe
  Komponente für beide, die Wahl des Eingangs trifft die jeweilige Stelle
  (Geräte-Trennung).

  Gespeichert wird bei DIESEM Server mit seiner Sitzung (`PATCH
  /admin/permissions`), auch wenn er gerade nicht der aktive ist. Der Server
  verteilt den Namen an verbundene Mitglieder und meldet ihn der Cloud, die ihn
  allen anderen mit der Serverliste ausliefert. Wer darf, entscheidet der Server
  (403); die Oberfläche zeigt den Eintrag nur denen, die er ansprechen würde
  (`servers/umbenennen.ts`).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import { adminApi } from '$lib/api/admin';
  import { serversStore, type ServerEntry } from '$lib/api/servers.svelte';
  import { nameVomServer } from '$lib/servers/anzeige';
  import { SERVER_NAME_MAX, zuSpeichernderName } from '$lib/servers/umbenennen';
  import { errText } from '$lib/utils/errText';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = false,
    server,
    onClose
  }: {
    open?: boolean;
    server: ServerEntry | null;
    onClose: () => void;
  } = $props();

  let name = $state('');
  let busy = $state(false);

  // Der gesetzte Name — leer, wenn keiner gesetzt ist (dann zeigt die Leiste
  // die Adresse, und die gehört nicht ins Feld).
  const aktuell = $derived(server ? server.anzeigename || server.server_name || null : null);

  // Nur beim Öffnen vorbelegen: ein Live-Ereignis darf nicht überschreiben,
  // was gerade getippt wird.
  $effect(() => {
    if (open) name = untrack(() => aktuell ?? '');
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      busy = false;
      onClose();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!server || busy) return;
    const neu = zuSpeichernderName(name, aktuell);
    if (neu === null) {
      onClose();
      return;
    }
    busy = true;
    try {
      // Leer geht als "" hinaus (= zurück zur Adresse); der Server antwortet mit
      // dem bereinigten Stand, und der gilt.
      const updated = await adminApi.patchPermissions(
        { instance_name: neu },
        { serverId: server.id }
      );
      serversStore.update(server.id, nameVomServer(updated.instance_name));
      toast.success(m.server_rename_saved());
      onClose();
    } catch (err) {
      toast.error(m.server_rename_failed(), { description: errText(err) });
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="server-rename-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.server_rename_title()}</Dialog.Title>
      <Dialog.Description>{m.server_rename_description()}</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <FieldLabel
          for="server-rename-name"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          {m.server_rename_label()}
        </FieldLabel>
        <Input
          id="server-rename-name"
          type="text"
          bind:value={name}
          maxlength={SERVER_NAME_MAX}
          placeholder={m.server_rename_placeholder()}
          autocomplete="off"
          disabled={busy}
          data-testid="server-rename-name"
        />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)} disabled={busy}>
          {m.server_rename_cancel()}
        </Button>
        <Button type="submit" disabled={busy} data-testid="server-rename-submit">
          {busy ? m.server_rename_saving() : m.server_rename_save()}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
