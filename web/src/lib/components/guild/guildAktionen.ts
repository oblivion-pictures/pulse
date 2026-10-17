/**
 * Die Aktionen einer Community — die EINE Liste, aus der beide Darstellungen
 * entstehen: das Kontextmenü der `GuildRail` am Rechner (`ZeilenKontextInhalt`)
 * und das Blatt hinter dem ⋯-Knopf der Kachel im Räume-Bereich am Handy
 * (`mobile/CommunityAktionen`). Vorher stand sie hart im Markup der Leiste; ein
 * zweites Blatt daneben hätte sie ein zweites Mal abgeschrieben, und die
 * Rechte-Bedingungen wären an zwei Stellen auseinandergelaufen.
 *
 * Reihenfolge, Rechte und `data-testid` des Rechner-Menüs sind unverändert.
 * Am Handy fallen Symbol ändern/entfernen und Community löschen weg
 * (die Rückrufe fehlen: Dateiauswahl und Löschen gehören dort nicht ans
 * Blatt); es kommen die Mitglieder dazu.
 *
 * Bewusst keine Benachrichtigungsstufe: sie gehört dem SERVER
 * (`ServerEntry.notification_mode`), nicht der Community, und stünde im
 * Community-Blatt irreführend als deren Einstellung da.
 */
import SettingsIcon from '@lucide/svelte/icons/settings';
import PencilIcon from '@lucide/svelte/icons/pencil';
import ImageIcon from '@lucide/svelte/icons/image';
import ImageOffIcon from '@lucide/svelte/icons/image-off';
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import LogOutIcon from '@lucide/svelte/icons/log-out';
import UsersIcon from '@lucide/svelte/icons/users';
import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
import { roles } from '$lib/stores/roles.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
import { Perm } from '$lib/permissions/bitfield';
import type { ServerEntry } from '$lib/api/servers.svelte';
import type { Guild } from '$lib/api/types';
import { m } from '$lib/paraglide/messages.js';

/**
 * Cloud: `is_admin`-Flag aus dem Auth-State; Self-Host: der `serverAdmin`-Store
 * aus dem Ready-Frame.
 */
export function istAdminAufServer(server: ServerEntry): boolean {
  return server.isCloud ? !!auth.user?.is_admin : serverAdmin.isAdmin(server.id);
}

export interface GuildRechte {
  isOwner: boolean;
  canManageGuild: boolean;
  canManageRoles: boolean;
  canModerate: boolean;
  isServerAdmin: boolean;
}

/**
 * Rechte an einer Community. Nur für den AKTIVEN Server: Rollen und Besitzer
 * liegen nur dort im Speicher, für fremde Server sind alle Rechte `false`
 * (dann bleibt die Aktionsliste leer, wie das Menü der Leiste).
 */
export function guildRechte(
  g: Guild,
  o: { aktiverServer: boolean; userId: string | null; serverAdmin: boolean }
): GuildRechte {
  const aktiv = o.aktiverServer;
  const darf = (p: bigint): boolean => aktiv && roles.hasGuildPermission(g.id, p);
  return {
    isOwner: aktiv && o.userId !== null && g.owner_id === o.userId,
    canManageGuild: darf(Perm.MANAGE_GUILD),
    canManageRoles: darf(Perm.MANAGE_ROLES),
    canModerate: darf(Perm.MANAGE_MESSAGES) || darf(Perm.BAN_MEMBERS) || darf(Perm.MANAGE_GUILD),
    isServerAdmin: o.serverAdmin
  };
}

export interface GuildAktionenTun {
  einstellungen: () => void;
  umbenennen: () => void;
  verlassen: () => void;
  /** Nur Rechner (Dateiauswahl, Löschen): am Handy weggelassen. */
  symbolWaehlen?: () => void;
  symbolEntfernen?: () => void;
  loeschen?: () => void;
  /** Nur Handy. */
  mitglieder?: () => void;
}

export function guildAktionen(g: Guild, r: GuildRechte, tun: GuildAktionenTun): ZeilenAktion[] {
  const liste: ZeilenAktion[] = [];
  // Einstieg, sobald IRGENDEIN Dialog-Reiter sichtbar wäre: Rollen /
  // Guild-Verwaltung (Sounds, Plugins, …) / Mod-Queue / Ownership — sonst
  // landen MANAGE_GUILD- oder Mod-Inhaber vor einer verschlossenen Tür.
  if (r.canManageRoles || r.canManageGuild || r.canModerate || r.isOwner) {
    liste.push({
      id: 'einstellungen',
      label: m.guild_rail_settings(),
      icon: SettingsIcon,
      onSelect: tun.einstellungen,
      testid: 'guild-settings'
    });
  }
  if (r.canManageGuild) {
    liste.push({
      id: 'umbenennen',
      label: m.guild_rail_rename_community(),
      icon: PencilIcon,
      onSelect: tun.umbenennen,
      testid: 'guild-rename'
    });
    if (tun.symbolWaehlen) {
      liste.push({
        id: 'symbol-setzen',
        label: m.guild_rail_change_icon(),
        icon: ImageIcon,
        onSelect: tun.symbolWaehlen,
        testid: 'guild-icon-set'
      });
    }
    if (tun.symbolEntfernen && g.icon_url) {
      liste.push({
        id: 'symbol-entfernen',
        label: m.guild_rail_remove_icon(),
        icon: ImageOffIcon,
        onSelect: tun.symbolEntfernen,
        testid: 'guild-icon-clear'
      });
    }
  }
  if (tun.mitglieder) {
    liste.push({
      id: 'mitglieder',
      label: m.community_aktion_mitglieder(),
      icon: UsersIcon,
      onSelect: tun.mitglieder,
      testid: 'guild-members'
    });
  }
  if (tun.loeschen && (r.isOwner || r.isServerAdmin)) {
    liste.push({
      id: 'loeschen',
      label: m.guild_rail_delete_community(),
      icon: Trash2Icon,
      onSelect: tun.loeschen,
      testid: 'guild-delete',
      variant: 'danger',
      trenner: r.canManageGuild
    });
  }
  // Verlassen: jedes Mitglied AUSSER dem Owner (der muss erst übertragen oder
  // löschen). Funktioniert identisch Cloud + Self-Host.
  if (!r.isOwner) {
    liste.push({
      id: 'verlassen',
      label: m.guild_rail_leave_community(),
      icon: LogOutIcon,
      onSelect: tun.verlassen,
      testid: 'guild-leave',
      variant: 'danger',
      trenner: r.canManageGuild || r.canManageRoles || r.isServerAdmin
    });
  }
  return liste;
}
