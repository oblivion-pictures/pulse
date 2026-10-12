<!--
  Server umbenennen — der Betreiber (oder ein Admin) gibt seinem Self-Host einen
  Namen, den ALLE Mitglieder statt der Adresse sehen.

  Hängt EINMAL im App-Layout und liest `stores/serverRename`. Geöffnet wird er
  per Rechtsklick auf den Server in der Leiste (`ServerRenameMenuItem`, am
  Rechner), per Tipp auf die Server-Zeile im Räume-Bereich (`/app/rooms`,
  Handy/Tablet) oder über „Umbenennen“ auf „Meine Server“ (`account/MyInstances`,
  alle Geräte) — die Wahl des Eingangs trifft die jeweilige Stelle
  (Geräte-Trennung), der Dialog ist für alle derselbe.

  Gespeichert wird bei DIESEM Server mit seiner Sitzung (`PATCH
  /admin/permissions`), auch wenn er gerade nicht der aktive ist. Der Server
  bereinigt den Namen, verteilt ihn an verbundene Mitglieder und meldet ihn der
  Cloud, die ihn allen anderen mit der Serverliste ausliefert. Übernommen wird
  die ANTWORT des Servers, nicht das Getippte. Wer darf, entscheidet der Server
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
  import { serversStore } from '$lib/api/servers.svelte';
  import { serverRename } from '$lib/stores/serverRename.svelte';
  import { SERVER_NAME_MAX, zuSpeichernderName } from '$lib/servers/umbenennen';
  import { errText } from '$lib/utils/errText';
  import { m } from '$lib/paraglide/messages.js';

  let name = $state('');
  let busy = $state(false);

  // Der Eintrag in seinem heutigen Stand (das Ziel im Store ist die Momentaufnahme
  // vom Öffnen).
  const server = $derived(
    serverRename.target ? (serversStore.find(serverRename.target.id) ?? serverRename.target) : null
  );

  // Der gesetzte Name — leer, wenn keiner gesetzt ist (dann zeigt die Leiste
  // die Adresse, und die gehört nicht ins Feld).
  const aktuell = $derived(server ? server.anzeigename || server.server_name || null : null);

  // Nur beim Öffnen vorbelegen: ein Live-Ereignis darf nicht überschreiben,
  // was gerade getippt wird.
  $effect(() => {
    if (serverRename.open) name = untrack(() => aktuell ?? '');
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      busy = false;
      serverRename.close();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!server || busy) return;
    const neu = zuSpeichernderName(name, aktuell);
    if (neu === null) {
      serverRename.close();
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
      serversStore.setzeServerName(server.id, updated.instance_name);
      toast.success(m.server_rename_saved());
      serverRename.close();
    } catch (err) {
      toast.error(m.server_rename_failed(), { description: errText(err) });
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root open={serverRename.open} onOpenChange={handleOpenChange}>
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
