<!--
  „Meine Server“ — die eigenen Server des Kontos (Route `/app/server`).
  Endpoint: GET /me/instances (Cookie-Auth via instancesApi).

  Seit dem Wegfall der Freigabe (2026-10, Spec 2026-10-09 §5) steht hier nur
  die Verwaltung: Diagnose und Löschen. Das Einrichten eines freigegebenen VPS
  („Server einrichten“ mit Installer-Befehl und `.env`) ist entfallen — ein
  neuer Server verbindet sich beim Installieren selbst (`pulse-connect`).

  Liegt für einen Server ein Übernahme-Antrag eines anderen Kontos vor, trägt
  sein Eintrag `uebernahme_frist_bis` und zeigt den Hinweis mit „Widersprechen“
  (`UebernahmeHinweis`, Widerspruchsfrist, Nachtrag 2026-10-11).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { currentLocale } from '$lib/i18n';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import { serversStore } from '$lib/api/servers.svelte';
  import { removeServerLocally } from '$lib/api/server-removal';
  import InstanceDiagnose from './InstanceDiagnose.svelte';
  import UebernahmeHinweis from './UebernahmeHinweis.svelte';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let deleteTarget = $state<Instance | null>(null);
  let deleteConfirmOpen = $state(false);
  let deleting = $state(false);

  function openDelete(inst: Instance) {
    deleteTarget = inst;
    deleteConfirmOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    deleting = true;
    const id = deleteTarget.id;
    try {
      await instancesApi.deleteMyInstance(id);
      instances = instances.filter((i) => i.id !== id);
      // Auch aus der eigenen Server-Leiste entfernen (Match über die
      // Instanz-ID) — andere Geräte/User räumt der Start-Sweep auf
      // (deleted-instance-sweep.ts).
      const localEntry = serversStore.servers.find((s) => s.instance_id === id);
      if (localEntry) removeServerLocally(localEntry.id);
      toast.success(m.my_instances_delete_success());
    } catch {
      toast.error(m.my_instances_delete_error());
    } finally {
      deleting = false;
      deleteConfirmOpen = false;
      deleteTarget = null;
    }
  }

  /** Liste holen — beim Öffnen und nach einem Widerspruch. */
  async function laden() {
    try {
      // Nur EIGENE Instanzen: die Antwort enthält auch Server, denen man bloß
      // beigetreten ist (Account-basierte Server-Liste) — die gehören in die
      // Server-Leiste, nicht hierher. Ohne den Filter bot diese Liste einem
      // Mitglied das Löschen eines fremden Servers an; die Routen sind
      // owner-verriegelt, der Knopf sah nur echt aus.
      instances = (await instancesApi.listMyInstances()).filter((i) => i.role === 'owner');
    } catch {
      // Nicht kritisch
    } finally {
      loading = false;
    }
  }

  onMount(laden);

  function statusClass(s: string): string {
    return s === 'active' ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive';
  }
</script>

<div class="flex flex-col gap-5" data-testid="my-instances">
  {#if loading}
    <LoadingState label={m.my_instances_loading()} />
  {:else if instances.length === 0}
    <EmptyState message={m.eigener_server_liste_leer()} />
  {:else}
    <div class="flex flex-col gap-2">
      {#each instances as inst (inst.id)}
        <div
          class="border-border bg-bg-input/30 flex flex-col gap-2 rounded-xl border p-3"
          data-testid="instance-row-{inst.id}"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-text-bright truncate text-sm font-medium">{inst.hostname}</p>
              <p class="text-text-muted mt-0.5 text-xs">
                {#if inst.origin === 'app_host'}
                  {m.my_instances_apphost_label()} ·
                {/if}
                {m.eigener_server_eingetragen_am({
                  date: new Date(inst.registered_at).toLocaleDateString(currentLocale())
                })}
              </p>
            </div>
            <!-- „Aktiv“ statt des früheren „Freigegeben“ (Skizze des Eigentümers,
                 2026-10-10): eine Freigabe gibt es nicht mehr. Die Pille sagt
                 weiter nur, ob die Cloud den Server gesperrt hat — nicht, ob er
                 läuft; das beantwortet die Verbindungsprüfung darunter. -->
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium {statusClass(inst.status)}">
              {inst.status === 'active'
                ? m.eigener_server_status_aktiv()
                : m.my_instances_status_suspended()}
            </span>
          </div>
          {#if inst.uebernahme_frist_bis}
            <UebernahmeHinweis instanz={inst} onGeaendert={laden} />
          {/if}
          <!-- Ob der Server von draußen ankommt, kann er selbst nicht sagen.
               Gilt seit dem Verbindungs-Check (2026-09-30) auch für Heim-Server:
               die Kette läuft gegen die Relay-Adresse. -->
          <InstanceDiagnose instanceId={inst.id} />
          <div class="mt-1 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="xs"
              onclick={() => openDelete(inst)}
              data-testid="instance-delete-btn-{inst.id}"
            >
              <Trash2Icon class="size-3.5" />
              {m.my_instances_delete_button()}
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Lösch-Bestätigung -->
<AlertDialog.Root bind:open={deleteConfirmOpen}>
  <AlertDialog.Content data-testid="instance-delete-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.my_instances_delete_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {deleteTarget?.origin === 'app_host'
          ? m.my_instances_apphost_delete_description()
          : m.eigener_server_loeschen_text({ hostname: deleteTarget?.hostname ?? '' })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.my_instances_delete_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDelete} disabled={deleting} data-testid="instance-delete-confirm">
        {m.my_instances_delete_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
