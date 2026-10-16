/**
 * Wer den Standplatz-Kanal eines Remote-Rechners sieht — für die
 * Freigabeliste, als reine Rechnung.
 *
 * **Warum das die Liste braucht** (seit 2026-10-16): eine Freigabe wirkt nur,
 * wenn der Freigegebene den Standplatz auch sieht (`VIEW_CHANNEL`); „jeder"
 * heisst „jeder, der den Kanal sieht". Ein Eintrag für jemanden ohne Sicht
 * steht also wirkungslos in der Liste. Die Auswahl schlägt deshalb nur vor,
 * wer den Kanal sieht, und vorhandene Einträge ohne Sicht bekommen einen
 * Hinweis.
 *
 * **Ohne Server-Erweiterung lösbar:** dieselben Daten, mit denen die
 * Kanalrechte-Ansicht und die Ablage-Gruppensitzung rechnen (Mitglieder,
 * Rollen, Rollen je Mitglied, Kanal-Overwrites — alle für jedes Mitglied mit
 * Sicht lesbar), durch denselben Resolver (`permissions/bitfield.ts`, Spiegel
 * des Server-Resolvers). Das Laden steht in `freigabeAuswahl.ts`.
 *
 * **Eine Untergrenze, wie überall im Client:** der Instanz-Admin-Status eines
 * fremden Nutzers ist hier unbekannt (er sieht serverseitig alles). Eine
 * Rolle gilt als sehend, wenn ein Mitglied mit genau `@everyone` und dieser
 * Rolle den Kanal sähe — dieselbe Annahme wie `permissions/kanalansicht.ts`.
 *
 * Importfrei bis auf importfreie Nachbarn mit Endung (`pnpm test:unit`-Falle).
 */

import {
  resolveChannelPermissions,
  has,
  Perm,
  type RoleSnapshot,
  type OverwriteSnapshot,
} from '../permissions/bitfield.ts';
import {
  sichtbareMitglieder,
  type KanalMitgliedRohdaten,
} from '../krypto/gruppe/kanalSichtbareMitglieder.ts';

export interface KanalSicht {
  /** Mitglieder, die den Kanal sehen. */
  nutzer: ReadonlySet<string>;
  /** Alle geladenen Mitglieder — wer hier fehlt, ist unbekannt, nicht blind
   *  (die Mitgliederliste kommt höchstens 100 Einträge lang). */
  bekannt: ReadonlySet<string>;
  /** Rollen, deren Träger den Kanal sehen. */
  rollen: ReadonlySet<string>;
}

export function kanalSicht(args: {
  mitglieder: KanalMitgliedRohdaten[];
  rollen: RoleSnapshot[];
  overwrites: OverwriteSnapshot[];
  besitzerId: string | null;
}): KanalSicht {
  const everyone = args.rollen.filter((r) => r.is_everyone);
  const rollen = new Set<string>();
  for (const r of args.rollen) {
    if (r.is_everyone) continue;
    const wert = resolveChannelPermissions({
      isGlobalAdmin: false,
      isOwner: false,
      isMember: true,
      // Leer: keine Mitglieds-Abweichung greift, gerechnet wird allein die Rolle.
      userId: '',
      roles: [...everyone, r],
      overwrites: args.overwrites,
    });
    if (has(wert, Perm.VIEW_CHANNEL)) rollen.add(r.id);
  }
  return {
    nutzer: new Set(sichtbareMitglieder(args)),
    bekannt: new Set(args.mitglieder.map((mm) => mm.userId)),
    rollen,
  };
}

/**
 * Wirkt dieser Eintrag, soweit der Client es sagen kann?
 *
 * `null` (Sicht nicht geladen) und unbekannte Nutzer zählen als „wirkt" — ein
 * Hinweis, der falsch warnt, ist schlimmer als einer, der fehlt; der Server
 * prüft ohnehin bei jeder Handlung.
 */
export function eintragWirkt(
  sicht: KanalSicht | null,
  g: { subject_type: 'user' | 'role' | 'everyone'; subject_id: string | null },
): boolean {
  if (!sicht || g.subject_type === 'everyone' || !g.subject_id) return true;
  if (g.subject_type === 'role') return sicht.rollen.has(g.subject_id);
  return !sicht.bekannt.has(g.subject_id) || sicht.nutzer.has(g.subject_id);
}
