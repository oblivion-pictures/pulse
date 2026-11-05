/**
 * Die Anruf-Systemzeile als GEMEINSAME Nachricht (Anrufe-Epic B): nach dem
 * Ende trägt der Einleiter-Client „Anruf verpasst“ / „Anruf abgelehnt“ /
 * „Anruf · Dauer“ in den Kanal ein — als ganz normale Nachricht, ohne eigenen
 * Endpunkt. Ob und was geschrieben wird, entscheidet `systemzeileKern.ts`;
 * diese Datei ist nur der Weg.
 *
 * Sie wird vom WS-Bootstrap (`ws/handlers/anrufe.ts`) über
 * `anrufe.zeilenZielSetzen` angedockt — bewusst Injektion statt Import im
 * Store: die Sendekette zieht den halben WS-/Krypto-Stack nach sich, der
 * Store liefe in einen Zyklus. Die Zeile geht verschlüsselt hinaus, wie
 * jede getippte DM (`chat/dmSenden.ts`); einen Klartext-Weg gibt es nicht
 * mehr, der Server nimmt seit 2026-11-05 keinen Klartext in DMs an.
 *
 * Eine verpasste Zustellung wird still ignoriert: die Zeile dokumentiert nur,
 * sie darf nach dem Auflegen keinen Fehler-Toast werfen und kein Duplikat-
 * Risiko durch einen zweiten Anlauf eingehen.
 */
import { m } from '$lib/paraglide/messages.js';
import { formatiereDauer } from '$lib/attachments/aufnahmeKern';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { messages } from '$lib/stores/messages.svelte';
import type { AnrufZeilenSchluessel } from './systemzeileKern';

export function sendeAnrufSystemzeile(
  kanalId: string,
  schluessel: AnrufZeilenSchluessel,
  dauerSek: number
): void {
  const dm = directMessages.byId[kanalId];
  if (!dm || !auth.user) return; // kein DM-Gespräch mehr / abgemeldet — nichts zu dokumentieren
  const text =
    schluessel === 'verpasst'
      ? m.anruf_zeile_verpasst()
      : schluessel === 'abgelehnt'
        ? m.anruf_zeile_abgelehnt()
        : m.anruf_zeile_dauer({ dauer: formatiereDauer(dauerSek) });

  // Der verschlüsselte Sendeweg — dynamisch importiert, s. Modulkopf.
  void import('$lib/krypto/senden').then(async ({ sendeVerschluesselt }) => {
    try {
      const ergebnis = await sendeVerschluesselt(kanalId, dm.other_user_id, text);
      if (ergebnis?.art === 'verschluesselt') messages.upsert(ergebnis.nachricht);
    } catch {
      // Nur Dokumentation — still, s. Modulkopf.
    }
  });
}
