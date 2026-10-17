/**
 * Die Aktionen einer Kanalzeile (Rechtsklick, Langdruck, ⋯-Knopf am Handy) —
 * einmal beschrieben für alle drei Abschnitte (Text, Ablage, Sprache). Vorher
 * stand dieselbe Folge „Umbenennen, Berechtigungen, Melden, Löschen" dreimal
 * hart im Markup. Reihenfolge und `data-testid` sind die der alten Menüs.
 */
import { goto } from '$app/navigation';
import PencilIcon from '@lucide/svelte/icons/pencil';
import ShieldIcon from '@lucide/svelte/icons/shield';
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import FlagIcon from '@lucide/svelte/icons/flag';
import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
import type { Channel, Guild } from '$lib/api/types';
import { m } from '$lib/paraglide/messages.js';

export interface KanalAktionenOptionen {
  guild: Guild | null;
  canCreate: boolean;
  /** Fehlt bei der Ablage: dort gibt es keinen Berechtigungs-Eintrag. */
  canManagePermissions?: boolean;
  onRename: (c: Channel) => void;
  onDelete: (c: Channel) => void;
  onReport: (c: Channel) => void;
  /** Einträge VOR „Umbenennen" (Sprache: Auto-Verbinden, Raumklang). */
  anfang?: ZeilenAktion[];
  /** Einträge zwischen „Umbenennen" und „Berechtigungen" (Sprache: Gast-Links). */
  mitte?: ZeilenAktion[];
}

export function kanalAktionen(c: Channel, o: KanalAktionenOptionen): ZeilenAktion[] {
  const liste: ZeilenAktion[] = [...(o.anfang ?? [])];
  if (o.canCreate) {
    liste.push({
      id: 'umbenennen',
      label: m.channel_list_rename_channel(),
      icon: PencilIcon,
      onSelect: () => o.onRename(c),
      testid: 'channel-context-settings',
      trenner: (o.anfang?.length ?? 0) > 0
    });
  }
  liste.push(...(o.mitte ?? []));
  if (o.canManagePermissions && o.guild) {
    const guildId = o.guild.id;
    liste.push({
      id: 'berechtigungen',
      label: m.channel_list_permissions(),
      icon: ShieldIcon,
      onSelect: () => void goto(`/app/guilds/${guildId}/channels/${c.id}/permissions`),
      testid: `channel-permissions-${c.id}`
    });
  }
  // Melden steht jedem Mitglied offen, nicht nur Managern.
  liste.push({
    id: 'melden',
    label: m.channel_list_report(),
    icon: FlagIcon,
    onSelect: () => o.onReport(c),
    testid: `channel-report-${c.id}`
  });
  if (o.canCreate) {
    liste.push({
      id: 'loeschen',
      label: m.channel_list_delete_channel(),
      icon: Trash2Icon,
      onSelect: () => o.onDelete(c),
      variant: 'danger',
      trenner: true
    });
  }
  return liste;
}
