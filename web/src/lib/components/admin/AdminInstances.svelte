<!--
  Admin: alle Server, die die Cloud kennt (Reiter „Server“). Drei Unterreiter:
  Aktiv · Gesperrt · Diagnose. Der Unterreiter „Ausstehend“ und sein Zähler
  sind mit der Freigabe entfallen (2026-10, Spec 2026-10-09 §5) — neue Server
  tauchen unter „Aktiv“ auf, sobald ihr Betreiber sie verbindet.
-->
<script lang="ts">
  import AdminInstancesActive from './AdminInstancesActive.svelte';
  import AdminInstancesSuspended from './AdminInstancesSuspended.svelte';
  import AdminDiagnose from './AdminDiagnose.svelte';
  import AdminTabBar from './AdminTabBar.svelte';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { m } from '$lib/paraglide/messages.js';

  type Tab = 'active' | 'suspended' | 'diagnose';
  let activeTab = $state<Tab>('active');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'active', label: m.admin_instances_tab_active() },
    { id: 'suspended', label: m.admin_instances_tab_suspended() },
    { id: 'diagnose', label: m.admin_diagnose_tab() }
  ];
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-instances">
  <div class="mb-4 flex items-start gap-3">
    <ServerIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
    <div class="min-w-0">
      <h2 class="text-text-bright text-base font-semibold">{m.admin_instances_heading()}</h2>
      <p class="text-text-muted mt-0.5 text-xs">{m.admin_instances_description_frei()}</p>
    </div>
  </div>

  <AdminTabBar bind:active={activeTab} {tabs} testIdPrefix="instances-tab" />

  {#if activeTab === 'active'}
    <AdminInstancesActive />
  {:else if activeTab === 'suspended'}
    <AdminInstancesSuspended />
  {:else}
    <AdminDiagnose />
  {/if}
</section>
