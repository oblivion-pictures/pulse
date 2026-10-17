<script lang="ts">
  /**
   * Die Sprachkanäle der Kanalliste samt Teilnehmern, Standplatz-Geräten,
   * Auto-Verbinden und dem räumlichen Klang-Steller.
   *
   * Aus `ChannelList.svelte` herausgelöst — siehe `ChannelTextSection.svelte`.
   * Der grösste der drei Abschnitte, weil an einer Sprachkanal-Zeile deutlich
   * mehr hängt als an einer Textkanal-Zeile: die Teilnehmerliste, fremde
   * Bildschirmströme, Watch-Partys und die Ablegefläche für Nutzer und Geräte.
   * Markup unverändert, `data-testid` identisch.
   */
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import LockIcon from '@lucide/svelte/icons/lock';
  import ZapIcon from '@lucide/svelte/icons/zap';
  import ZapOffIcon from '@lucide/svelte/icons/zap-off';
  import { voice } from '$lib/voice/livekit.svelte';
  import { voiceAutoConnect } from '$lib/voice/autoconnect.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { inVoiceChannel } from '$lib/voice/state.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { chooseHqForUser } from '$lib/stream/hqTile';
  import { channelNameStyle } from '$lib/utils/nameColor';
  import { settings } from '$lib/stores/settings.svelte';
  import { CHANNEL_BTN_CLASS } from '$lib/channels/stil';
  import {
    KanalZiehen,
    beginnen,
    beenden,
    sprachDarueber,
    sprachVerlassen,
    sprachAblegen,
    type ZiehKontext
  } from '$lib/channels/ziehen.svelte';
  import LinkIcon from '@lucide/svelte/icons/link';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import GastLinkDialog from '$lib/gast/GastLinkDialog.svelte';
  import ChannelTopicTooltip from '../ChannelTopicTooltip.svelte';
  import ZeilenKontextInhalt from '$lib/components/menu/ZeilenKontextInhalt.svelte';
  import ZeilenMenue from '$lib/components/mobile/ZeilenMenue.svelte';
  import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
  import { kanalAktionen } from '$lib/channels/kanalAktionen';
  import VoiceChannelPresence from './VoiceChannelPresence.svelte';
  import DeviceChannelRows from '$lib/devices/components/DeviceChannelRows.svelte';
  import type { Device } from '$lib/api/devices';
  import type { Channel, Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channels,
    guild,
    myId,
    /** Handy-Klasse? Vom Mount-Punkt hereingereicht (Geraete-Trennung):
     *  blendet den Raumklang-Eintrag im Kontextmenue aus und wandert an
     *  VoiceChannelPresence weiter (dort: raeumlicher Klang-Steller). */
    handy,
    activeChannelId = null,
    canCreate = false,
    canManagePermissions = false,
    canManageChannels = false,
    activeDeviceId = null,
    onSelectDevice,
    ziehen,
    kontext,
    onSelect,
    onRename,
    onDelete,
    onReport
  }: {
    channels: Channel[];
    guild: Guild | null;
    myId: string | null;
    handy: boolean;
    activeChannelId?: string | null;
    canCreate?: boolean;
    canManagePermissions?: boolean;
    canManageChannels?: boolean;
    activeDeviceId?: string | null;
    onSelectDevice?: (device: Device) => void;
    ziehen: KanalZiehen;
    kontext: ZiehKontext;
    onSelect: (c: Channel) => void;
    onRename: (c: Channel) => void;
    onDelete: (c: Channel) => void;
    onReport: (c: Channel) => void;
  } = $props();

  // Offener Gast-Link-Dialog (Kanal-ID) — einer für alle Zeilen: es ist immer
  // höchstens einer offen, und ein Dialog je Kanalzeile wäre N Dialoge im
  // Baum, von denen N-1 nichts tun.
  let gastLinkKanal = $state<string | null>(null);
  let gastLinkOffen = $state(false);

  // Auto-Connect-Wahl (gerätelokal, an User + Server gebunden). Es kann nur
  // EINEN Auto-Connect-Channel pro Gerät geben — Setzen verschiebt den Blitz.
  function toggleAutoConnect(c: Channel) {
    if (voiceAutoConnect.isTarget(c.id)) {
      voiceAutoConnect.clear();
    } else {
      if (!myId) return; // ohne aufgelöste User-ID keine Account-Bindung möglich
      voiceAutoConnect.set({
        serverId: activeServer.serverId,
        userId: myId,
        channelId: c.id,
        channelName: c.name,
        guildId: c.guild_id
      });
    }
  }

  // Die Aktionen einer Sprachkanal-Zeile — Rechtsklick, Langdruck und ⋯-Knopf
  // am Handy zeigen dieselbe Liste. Auto-Connect für alle Mitglieder (nicht nur
  // Admins); der Raumklang-Schalter nur am Rechner.
  function sprachAktionen(c: Channel): ZeilenAktion[] {
    const autoConnect = voiceAutoConnect.isTarget(c.id);
    return kanalAktionen(c, {
      guild,
      canCreate,
      canManagePermissions,
      onRename,
      onDelete,
      onReport,
      anfang: [
        {
          id: 'autoconnect',
          label: autoConnect ? m.channel_list_autoconnect_remove() : m.channel_list_autoconnect_set(),
          icon: autoConnect ? ZapOffIcon : ZapIcon,
          onSelect: () => toggleAutoConnect(c),
          testid: `channel-autoconnect-toggle-${c.id}`
        },
        {
          id: 'raumklang',
          label: m.settings_audio_video_spatial_label(),
          nurDesktop: true,
          testid: `channel-spatial-${c.id}`,
          schalter: {
            checked: settings.audio.spatialMode !== 'off',
            onChange: (an) => {
              const mode = an ? 'high' : 'off';
              settings.setSpatialMode(mode);
              voice.setSpatialMode(mode);
            }
          }
        }
      ],
      mitte:
        guild && roles.hasGuildPermission(guild.id, Perm.MOVE_MEMBERS)
          ? [
              {
                id: 'gast-links',
                label: m.gast_links_titel(),
                icon: LinkIcon,
                onSelect: () => {
                  gastLinkKanal = c.id;
                  gastLinkOffen = true;
                },
                testid: `channel-guest-links-${c.id}`
              }
            ]
          : []
    });
  }
</script>

{#if channels.length > 0}
  <div class="my-3 hairline bg-border" aria-hidden="true"></div>
  <div
    class="text-text-muted mb-1.5 inline-block rounded-full border border-border bg-bg-input px-2.5 py-1 text-sm font-bold nicht-handy:mb-0 nicht-handy:rounded-none nicht-handy:border-0 nicht-handy:bg-transparent nicht-handy:px-2.5 nicht-handy:py-0 nicht-handy:text-xs"
  >
    {m.channel_list_voice_channels()}
  </div>
  {#each channels as c (c.id)}
  {@const aktionen = sprachAktionen(c)}
  <div class="relative">
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props: ctxProps })}
        <ChannelTopicTooltip topic={c.topic}>
        {#snippet children(tipProps)}
        <button
          {...ctxProps}
          {...tipProps}
          class="{CHANNEL_BTN_CLASS} handy:pr-14 {ziehen.ueber === c.id
            ? 'border-t-2 border-primary'
            : ''} {ziehen.id === c.id ? 'opacity-50' : ''} {ziehen.nutzerUeber === c.id
            ? 'ring-2 ring-primary'
            : ''}"
          data-active={activeChannelId === c.id}
          onclick={() => onSelect(c)}
          draggable={canManageChannels}
          ondragstart={(e) => beginnen(e, c, ziehen, canManageChannels)}
          ondragover={(e) => sprachDarueber(e, c, ziehen, kontext)}
          ondragleave={(e) => sprachVerlassen(e, c, ziehen)}
          ondrop={(e) => void sprachAblegen(e, c, ziehen, kontext)}
          ondragend={() => beenden(ziehen)}
          data-testid={`channel-${c.id}`}
        >
          <Volume2Icon class="text-text-muted size-6 shrink-0 nicht-handy:size-[17px] group-data-[active=true]:text-primary" />
          <span class="truncate" style={channelNameStyle(c)}>{c.name}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5">
            {#if c.user_limit && c.user_limit > 0}
              <span
                class="text-text-muted text-2xs tabular-nums nicht-handy:text-2xs"
                title={m.channel_list_user_limit_title({ limit: c.user_limit })}
                data-testid={`channel-user-limit-${c.id}`}
              >{voicePresence.usersIn(c.id).length}/{c.user_limit}</span>
            {/if}
            {#if c.restricted}
              <LockIcon
                class="text-text-muted size-4 nicht-handy:size-3.5"
                data-testid={`channel-lock-${c.id}`}
                aria-label={m.channel_list_restricted()}
              />
            {/if}
            {#if voiceAutoConnect.isTarget(c.id)}
              <span
                class="shrink-0"
                title={m.channel_list_autoconnect_marker()}
                data-testid={`channel-autoconnect-${c.id}`}
              >
                <ZapIcon class="size-4 text-primary nicht-handy:size-3.5" aria-label={m.channel_list_autoconnect_marker()} />
              </span>
            {/if}
            {#if inVoiceChannel(c.id)}
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title={m.channel_list_connected()}></span>
            {/if}
          </span>
        </button>
        {/snippet}
        </ChannelTopicTooltip>
      {/snippet}
    </ContextMenu.Trigger>
    <ZeilenKontextInhalt {aktionen} {handy} />
  </ContextMenu.Root>
  <ZeilenMenue {aktionen} testid={`channel-menu-${c.id}`} titel={c.name} />
  </div>
  <VoiceChannelPresence channel={c} {myId} {handy} {onSelect} />
  <!-- Standplatz-Geraete stehen UNTER ihrem Kanal, nicht in einer eigenen
       Kategorie (Aenderung 2026-08-16, Begruendung in DeviceChannelRows) —
       und unter ALLEN Menschen des Kanals, nicht ueber ihnen: die
       Teilnehmerliste ist die bewegliche Groesse (wer kommt, wer geht), die
       Geraete stehen fest. Als Schlusszeile bleiben sie an derselben
       Stelle, statt die Namen darunter bei jedem Beitritt zu verschieben.
       Ausserhalb des `members`-Blocks, denn ein Geraet steht auch in einem
       Kanal, in dem gerade niemand sitzt — genau der Regelfall bei einem
       unbeaufsichtigten Rechner. -->
  {#if guild && onSelectDevice}
    <DeviceChannelRows
      guildId={c.guild_id}
      channelId={c.id}
      {activeDeviceId}
      onSelect={onSelectDevice}
      onDragEnd={() => beenden(ziehen)}
      onWatch={(d) => {
        // Nur die Plätze DIESES Geräts — nicht jeden Strom des Besitzers.
        chooseHqForUser(c.id, d.owner_user_id, undefined, d.stream_slots ?? []);
        onSelect(c);
      }}
    />
  {/if}
{/each}
{:else}
  <p class="text-text-muted px-3 py-2 text-xs">{m.channel_list_no_voice_channels()}</p>
{/if}

{#if gastLinkKanal && guild}
  <GastLinkDialog bind:open={gastLinkOffen} channelId={gastLinkKanal} guildId={guild.id} />
{/if}
