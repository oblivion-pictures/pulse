<!--
  Per-community limit editor, shown in the expanded community row. Owner-only.

  Zwei Arten von Feldern, die nicht verwechselt werden dürfen:
    * Grenzen — leer heißt „erbt den serverweiten Standard" bzw. „unbegrenzt".
      Der Platzhalter nennt den Wert, der dann tatsächlich gilt. Ausnahme:
      die zwei Datei-Obergrenzen (Größe, Anzahl) — dort heißt leer „nicht
      ändern" (Platzhalter „Aktuell: …"), weil ein gelöschter Wert nicht
      „unbegrenzt" wäre, sondern den Standard zurückholte und die Werte der
      Community still darauf herunterklemmte.
    * Freigaben — ein Schalter, kein Erben: aus heißt aus.

  Gruppiert nach dem, worum es geht, nicht danach, aus welcher Tabellenspalte
  es kommt: alles, was Dateien betrifft (Chat-Anhänge UND Ablage), steht
  zusammen — es ist derselbe Speicher-Gedanke, nur zwei Töpfe. Diese Gruppe
  steht in `AdminCommunityStorageLimits.svelte`; der Zustand bleibt hier, weil
  `save()` den vollen Satz aus einer Hand schickt.

  Speichert den vollen Satz über PATCH /owner/communities/{id}/limits; null
  löscht eine Übersteuerung. Inline-Felder ohne Dialog-Editor (das
  Auflösungs-Dropdown ist ein flüchtiges Popover, kein Zustandsträger) — safe
  in a re-rendering list.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Select from '$lib/components/form/Select.svelte';
  import LimitField from './LimitField.svelte';
  import LimitGroup from './LimitGroup.svelte';
  import AdminCommunityStorageLimits from './AdminCommunityStorageLimits.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { adminApi, type Community } from '$lib/api/admin';
  import {
    numOrNull,
    kbpsToMbpsStr,
    mbpsStrToKbps,
    bytesToUnitStr,
    unitStrToBytesKeep,
    MB,
    GB
  } from './communityLimitFormat';

  let { community, onSaved }: { community: Community; onSaved: (c: Community) => void } =
    $props();

  /** Instanz-Standard fuer den Geraete-Deckel je Person -- Spiegel von
   *  ``DEFAULT_MAX_DEVICES_PER_OWNER`` (guild_limits.py). Synchron halten. */
  const DEFAULT_MAX_DEVICES_PER_OWNER = 25;
  // "Native" ist ein interner Wert, kein Anzeigetext — Klappmenü und Platzhalter
  // beschriften ihn deshalb über denselben Weg.
  const resLabel = (r: string) => (r === 'Native' ? m.admin_communities_limits_res_native() : r);

  // Form state as strings ('' = inherit/default). Stream bitrate is shown in
  // Mbit/s (friendlier) and converted to kbps on save. Seeded once from the
  // community (the panel remounts per expand, so initial-only is intentional —
  // untrack marks that so we don't reset the owner's edits on a live update).
  let voice = $state(untrack(() => community.voice_bitrate_max_kbps?.toString() ?? ''));
  let streamMbps = $state(untrack(() => kbpsToMbpsStr(community.stream_bitrate_max_kbps)));
  let fps = $state(untrack(() => community.stream_fps_max?.toString() ?? ''));
  let resolution = $state(untrack(() => community.stream_resolution_max ?? ''));
  // Dateien (`AdminCommunityStorageLimits`): Speicher gesamt in GB (leer =
  // unbegrenzt), Größe je Datei in MB, Anzahl. Ablage: Freigabe (Schalter, kein
  // Erben) + eigener Speicher-Topf.
  let storageQuotaGB = $state(
    untrack(() => bytesToUnitStr(community.attachment_storage_quota_bytes, GB))
  );
  let attachSizeMB = $state(untrack(() => bytesToUnitStr(community.attachment_max_size_bytes, MB)));
  let attachCount = $state(untrack(() => community.attachment_max_count_per_message?.toString() ?? ''));
  let dropboxAllowed = $state(untrack(() => community.dropbox_allowed));
  let dropboxQuotaGB = $state(
    untrack(() => bytesToUnitStr(community.dropbox_quota_bytes, GB))
  );
  // Scale caps ('' = unlimited).
  let maxMembers = $state(untrack(() => community.max_members?.toString() ?? ''));
  let maxChannels = $state(untrack(() => community.max_channels?.toString() ?? ''));
  let maxRoles = $state(untrack(() => community.max_roles?.toString() ?? ''));
  let maxDevicesPerOwner = $state(
    untrack(() => community.max_devices_per_owner?.toString() ?? '')
  );
  let maxStreams = $state(untrack(() => community.max_concurrent_streams?.toString() ?? ''));
  let busy = $state(false);

  const RES_OPTIONS = ['Native', '4K', '1440p', '1080p', '720p', '480p'];

  // Der Leerwert ist eine WAHL („keine Übersteuerung, es gilt der instanz-
  // weite Standard") und kein Platzhalter: die Beschriftung nennt den dann
  // tatsächlich geltenden Wert — deshalb bleibt er ein echter Eintrag.
  const resAuswahl = $derived([
    {
      value: '',
      label: m.admin_communities_limits_placeholder_default({
        value: resLabel(capabilities.hqResolutionMax)
      })
    },
    ...RES_OPTIONS.map((r) => ({ value: r, label: resLabel(r) }))
  ]);

  async function save() {
    busy = true;
    try {
      const updated = await adminApi.setCommunityLimits(community.id, {
        voice_bitrate_max_kbps: numOrNull(voice),
        stream_bitrate_max_kbps: mbpsStrToKbps(streamMbps),
        stream_fps_max: numOrNull(fps),
        stream_resolution_max: resolution || null,
        // Der volle Satz geht immer mit. Ein unverändertes Feld schickt den
        // gespeicherten Wert, nicht die Rückrechnung der gerundeten Anzeige.
        attachment_max_size_bytes: unitStrToBytesKeep(
          attachSizeMB,
          community.attachment_max_size_bytes,
          MB
        ),
        attachment_max_count_per_message: numOrNull(attachCount),
        attachment_storage_quota_bytes: unitStrToBytesKeep(
          storageQuotaGB,
          community.attachment_storage_quota_bytes,
          GB
        ),
        max_members: numOrNull(maxMembers),
        max_channels: numOrNull(maxChannels),
        max_roles: numOrNull(maxRoles),
        max_devices_per_owner: numOrNull(maxDevicesPerOwner),
        max_concurrent_streams: numOrNull(maxStreams),
        dropbox_allowed: dropboxAllowed,
        dropbox_quota_bytes: unitStrToBytesKeep(dropboxQuotaGB, community.dropbox_quota_bytes, GB)
      });
      onSaved(updated);
      toast.success(m.admin_communities_limits_saved());
    } catch (e) {
      toast.error(m.admin_communities_limits_save_failed(), {
        description: errText(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<div class="mt-1 flex flex-col gap-3" data-testid="admin-community-limits">
  <LimitGroup
    title={m.admin_communities_limits_title()}
    hint={m.admin_communities_limits_hint()}
  >
    <div class="grid grid-cols-1 gap-3 nicht-handy:grid-cols-2">
      <LimitField
        label={m.admin_communities_limits_voice_bitrate()}
        bind:value={voice}
        fallback={capabilities.voiceBitrateMaxKbps}
        min="16" max="512" testid="community-limit-voice"
      />
      <LimitField
        label={m.admin_communities_limits_stream_bitrate()}
        bind:value={streamMbps}
        fallback={capabilities.hqBitrateMaxKbps / 1000}
        min="1" max="100" step="any" testid="community-limit-bitrate"
      />
      <LimitField
        label={m.admin_communities_limits_fps()}
        bind:value={fps}
        fallback={capabilities.hqFpsMax}
        min="1" max="1000" testid="community-limit-fps"
      />
      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_resolution()}</span>
        <Select
          value={resolution}
          options={resAuswahl}
          onchange={(v) => (resolution = v)}
          data-testid="community-limit-resolution"
        />
      </label>
    </div>
  </LimitGroup>

  <AdminCommunityStorageLimits
    {community}
    bind:storageQuotaGB
    bind:attachSizeMB
    bind:attachCount
    bind:dropboxAllowed
    bind:dropboxQuotaGB
  />

  <LimitGroup
    title={m.admin_communities_limits_scale_title()}
    hint={m.admin_communities_limits_scale_hint()}
  >
    <div class="grid grid-cols-1 gap-3 nicht-handy:grid-cols-2">
      <LimitField
        label={m.admin_communities_limits_max_members()}
        bind:value={maxMembers}
        fallback="unlimited"
        min="1" testid="community-limit-max-members"
      />
      <LimitField
        label={m.admin_communities_limits_max_channels()}
        bind:value={maxChannels}
        fallback="unlimited"
        min="1" testid="community-limit-max-channels"
      />
      <LimitField
        label={m.admin_communities_limits_max_roles()}
        bind:value={maxRoles}
        fallback="unlimited"
        min="1" testid="community-limit-max-roles"
      />
      <LimitField
        label={m.admin_communities_limits_max_devices()}
        bind:value={maxDevicesPerOwner}
        fallback={DEFAULT_MAX_DEVICES_PER_OWNER}
        min="1" testid="community-limit-max-devices"
      />
      <LimitField
        label={m.admin_communities_limits_max_streams()}
        bind:value={maxStreams}
        fallback="unlimited"
        min="0" testid="community-limit-max-streams"
      />
    </div>
  </LimitGroup>

  <div class="flex justify-end">
    <Button size="sm" onclick={save} disabled={busy} data-testid="community-limit-save">
      {m.admin_communities_limits_save()}
    </Button>
  </div>
</div>
