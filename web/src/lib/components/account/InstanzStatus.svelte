<!--
  Status-Pille eines eigenen Servers: „Aktiv“ oder „Gesperrt“ — auf der Seite
  „Meine Server“ (`MyInstances`) und im Menü des Server-Knopfs
  (`GuildRailServerButton`).

  „Aktiv“ statt des früheren „Freigegeben“ (Skizze des Eigentümers,
  2026-10-10): eine Freigabe gibt es nicht mehr. Die Pille sagt weiter nur, ob
  die Cloud den Server gesperrt hat — nicht, ob er läuft; das beantwortet die
  Verbindungsprüfung (`InstanceDiagnose`).
-->
<script lang="ts">
  import type { Instance } from '$lib/api/instances';
  import { m } from '$lib/paraglide/messages.js';

  let { status }: { status: Instance['status'] } = $props();

  let aktiv = $derived(status === 'active');
</script>

<span
  class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium {aktiv
    ? 'bg-success/20 text-success'
    : 'bg-destructive/20 text-destructive'}"
>
  {aktiv ? m.eigener_server_status_aktiv() : m.my_instances_status_suspended()}
</span>
