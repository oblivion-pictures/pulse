<!--
  Die Datei-Gruppe im Community-Grenzen-Editor (`AdminCommunityLimits.svelte`):
  Chat-Anhänge UND Ablage, weil es derselbe Speicher-Gedanke ist, nur zwei
  Töpfe.

  Hält selbst keinen Zustand: die fünf Formularwerte gehören dem Editor, der sie
  beim Speichern als vollen Satz schickt, und kommen als `$bindable` herein. Aus
  der Community wird nur gelesen, welche Obergrenze gerade gilt — für die
  Platzhalter der zwei Felder, bei denen leer „nicht ändern" heißt.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import Switch from '$lib/components/form/Switch.svelte';
  import LimitField from './LimitField.svelte';
  import LimitGroup from './LimitGroup.svelte';
  import type { Community } from '$lib/api/admin';
  import {
    bytesToUnit,
    ceilingOrDefault,
    MB,
    DEFAULT_ATTACH_MAX_SIZE_BYTES,
    DEFAULT_ATTACH_MAX_COUNT
  } from './communityLimitFormat';

  /** Instanz-Standard für den Ablage-Speicher — Spiegel von
   *  ``DEFAULT_DROPBOX_QUOTA_BYTES`` (_dropbox_policy.py). Synchron halten. */
  const DEFAULT_DROPBOX_QUOTA_GB = 1;

  let {
    community,
    storageQuotaGB = $bindable(''),
    attachSizeMB = $bindable(''),
    attachCount = $bindable(''),
    dropboxAllowed = $bindable(false),
    dropboxQuotaGB = $bindable('')
  }: {
    community: Community;
    storageQuotaGB?: string;
    attachSizeMB?: string;
    attachCount?: string;
    dropboxAllowed?: boolean;
    dropboxQuotaGB?: string;
  } = $props();
</script>

<LimitGroup
  title={m.admin_communities_limits_storage_title()}
  hint={m.admin_communities_limits_storage_hint()}
>
  <div class="grid grid-cols-1 gap-3 nicht-handy:grid-cols-2">
    <LimitField
      label={m.admin_communities_limits_storage_quota()}
      bind:value={storageQuotaGB}
      fallback="unlimited"
      min="0" step="any" testid="community-limit-storage-quota"
    />
    <!-- Diese beiden sind Obergrenzen mit Instanz-Standard, kein „unbegrenzt":
         leer lassen ändert nichts (der Server schreibt nur bei einem Wert),
         die bisherige Obergrenze gilt weiter. Genau die zeigt der
         Platzhalter — bei nie gesetzter Obergrenze den Instanz-Standard. -->
    <LimitField
      label={m.admin_communities_limits_attach_size()}
      bind:value={attachSizeMB}
      fallback={bytesToUnit(
        ceilingOrDefault(community.attachment_max_size_bytes, DEFAULT_ATTACH_MAX_SIZE_BYTES),
        MB
      )}
      keep
      min="1" step="any" testid="community-limit-attach-size"
    />
    <LimitField
      label={m.admin_communities_limits_attach_count()}
      bind:value={attachCount}
      fallback={ceilingOrDefault(
        community.attachment_max_count_per_message,
        DEFAULT_ATTACH_MAX_COUNT
      )}
      keep
      min="1" max="50" testid="community-limit-attach-count"
    />
  </div>

  <!-- Ablage steht bewusst in dieser Gruppe (derselbe Gegenstand: Dateien
       dieser Community, nur ein zweiter Topf), aber durch einen Trenner
       abgesetzt statt durch einen eigenen Rahmen — sonst Rahmen im Rahmen. -->
  <div class="border-border mt-4 border-t pt-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <span class="text-text-base text-sm font-medium">{m.admin_communities_limits_dropbox()}</span>
        <p class="text-text-muted mt-0.5 text-xs">{m.admin_communities_limits_dropbox_hint()}</p>
      </div>
      <Switch
        bind:checked={dropboxAllowed}
        aria-label={m.admin_communities_limits_dropbox()}
        data-testid="community-limit-dropbox"
      />
    </div>

    {#if dropboxAllowed}
      <div class="mt-3 grid grid-cols-1 gap-3 nicht-handy:grid-cols-2">
        <LimitField
          label={m.admin_communities_limits_dropbox_quota()}
          bind:value={dropboxQuotaGB}
          fallback={DEFAULT_DROPBOX_QUOTA_GB}
          min="0.01" step="any" testid="community-limit-dropbox-quota"
        />
        <p class="text-text-muted self-end text-xs">{m.admin_communities_limits_dropbox_quota_hint()}</p>
      </div>
    {/if}
  </div>
</LimitGroup>
