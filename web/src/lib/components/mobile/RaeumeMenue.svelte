<!--
  Menü oben rechts im Räume-Bereich (Handy und Tablet). Herausgezogen aus
  `routes/app/rooms/+page.svelte`, als „Eigenen Server einrichten“ dazukam —
  das Gegenstück zum Plus der GuildRail, die es hier nicht gibt (Spec
  2026-10-09 §5).

  Drei-Punkte wie in Chats und Freunde: Entdecken ist der Ausgang ins
  Verzeichnis, kein dauerhaft sichtbarer Zustand der eigenen Räume. „Community
  beitreten“ = Server per Adresse beitreten (Erstkontakt, kein Invite-Code):
  `/app?add=join` wie die GuildRail; warum es diesen Einstieg auf Handy und
  Tablet braucht, steht in `CommunityBeitretenKnopf.svelte`.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import CompassIcon from '@lucide/svelte/icons/compass';
  import LogInIcon from '@lucide/svelte/icons/log-in';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import ServerIcon from '@lucide/svelte/icons/server';
  import KopfMenue from './KopfMenue.svelte';
  import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Ein Knopf MIT WORT, der die Auswahl als Blatt von unten öffnet — vorher ein
  // wortloses ⋯ mit Popover im Desktop-Stil. Testids unverändert.
  const aktionen: ZeilenAktion[] = [
    {
      id: 'beitreten',
      label: m.guild_rail_join_community(),
      icon: LogInIcon,
      onSelect: () => void goto('/app?add=join'),
      testid: 'rooms-menu-join'
    },
    {
      id: 'entdecken',
      label: m.rooms_discover_short(),
      icon: CompassIcon,
      onSelect: () => void goto('/app/discover'),
      testid: 'rooms-menu-discover'
    },
    {
      id: 'eigener-server',
      label: m.eigener_server_einrichten(),
      icon: ServerIcon,
      onSelect: () => (uiOverlays.eigenerServerOpen = true),
      testid: 'rooms-eigener-server',
      trenner: true
    }
  ];
</script>

<KopfMenue wort={m.menue_mehr()} icon={EllipsisIcon} {aktionen} testid="rooms-menu" />
