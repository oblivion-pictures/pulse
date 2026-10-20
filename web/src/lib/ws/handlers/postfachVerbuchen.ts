/**
 * Verbucht frisch entschluesselte Postfach-Nachrichten in der Anzeige —
 * Nachrichtenliste, „schreibt …", DM-Liste bzw. Gruppen-Reihenfolge,
 * Ungelesen-Stand — und meldet sie, wo es passt.
 *
 * Herausgeloest aus `chat.ts::postfachAbholenUndAnzeigen` (2026-10-20), als der
 * Hintergrund-Takt der Hülle (`krypto/hintergrundTakt.ts`) denselben Weg
 * nehmen musste: bis dahin warf der Takt das Ergebnis seiner Abholung weg, und
 * im Hintergrund abgeholte Nachrichten fehlten danach in „ungelesen".
 *
 * `stumm`: der Hintergrund-Takt — kein Ton, kein Toast, keine In-Page-Meldung
 * (die Zählung laeuft trotzdem). Eine stummgeschaltete private Gruppe meldet
 * sich ebenfalls nicht (Ton, Toast, In-Page), zaehlt aber weiter als ungelesen
 * — dieselbe Grenze wie am Server, der fuer ein stummes Mitglied keinen Push
 * schickt (`fcm.dm_push_senden`).
 */
import type { Message } from '$lib/api/types';
import { messages } from '$lib/stores/messages.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { readState } from '$lib/stores/readState.svelte';
import { lesestandAnker } from '$lib/stores/lesestandKern';
import { typing } from '$lib/stores/typing.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { dmGegenstelle } from '$lib/krypto/dmGegenstelle';
import { siehtHin } from '$lib/nachrichten/hinschauen';
import { meldeNeueZustellung } from './postfachBenachrichtigung';

export function zustellungenVerbuchen(
  neue: readonly Message[],
  istAboniert: (kanalId: string) => boolean,
  { stumm }: { stumm: boolean }
): void {
  const me = currentServerUserId();
  for (const nachricht of neue) {
    messages.upsert(nachricht);
    // Wie im `message`-Handler (`chat.ts`): eine angekommene Nachricht beendet
    // das „X schreibt …" sofort — auf dem verschlüsselten Weg gibt es kein
    // Server-`message`-Ereignis, das das sonst besorgen könnte.
    typing.clear(nachricht.channel_id, nachricht.author_id);
    // Die DM-Liste nachziehen (Bughunt 2026-08-28, FIX 3) — der
    // verschluesselte Weg loest kein `dm_bump` aus, das die Reihenfolge/den
    // Ungelesen-Stand sonst besorgt. Gegenstelle: der Absender, ausser er ist
    // man selbst (eigenes anderes Geraet) — dann bleibt nur der bereits
    // bekannte Kanal-Gegenpart, s. `upsertFromEncrypted`-Docstring.
    if (!me) continue;
    // **Eine Gruppennachricht gehoert NICHT in die DM-Liste.** Ohne diese
    // Weiche liefe sie durch `dmGegenstelle` — das findet keinen
    // Kanal-Gegenpart und nimmt deshalb den Absender — und legte fuer den
    // Gruppenkanal einen DM-Eintrag an, der auf eine einzelne Person zeigt.
    const gruppe = privateGruppen.byId[nachricht.channel_id];
    if (!gruppe) {
      const otherUserId = dmGegenstelle(
        nachricht.author_id,
        me,
        directMessages.byId[nachricht.channel_id]?.other_user_id
      );
      if (otherUserId) {
        directMessages.upsertFromEncrypted({
          channel_id: nachricht.channel_id,
          message_id: nachricht.id,
          otherUserId,
          inhalt: nachricht.content,
          autorId: nachricht.author_id,
          erstelltAm: nachricht.created_at,
          anhaenge: nachricht.attachments
        });
      }
    } else {
      // Die Gruppenliste sortiert nach `last_message_id` (s.
      // `privateGruppen.svelte.ts`). Der Server ruehrt diese Spalte im
      // verschluesselten Weg nicht an — er sieht keine Nachricht —, also zieht
      // der Klient sie hier selbst nach. Reine Anzeige: die Mitgliederliste
      // bleibt unberuehrt, sie kommt beim Senden frisch vom Server
      // (`krypto/gruppe/sitzungswahl.ts`).
      privateGruppen.upsert({ ...gruppe, last_message_id: nachricht.id });
    }
    if (nachricht.author_id === me) continue;
    // Anker = kanonische Absender-ID (`krypto_id`), nicht die Zustellungs-ID —
    // sonst vergleicht der Sender seinen lokalen Stand später gegen eine
    // fremde Kennung (B3, s. `lesestandKern.lesestandAnker`).
    const anker = lesestandAnker(nachricht);
    readState.recordSeen(nachricht.channel_id, anker);
    // Offen UND hingeschaut — ein offenes Gespräch hinter einem minimierten
    // Fenster (oder einer App im Hintergrund) ist ungelesen (s.
    // `nachrichten/hinschauen.ts`); das Gespräch meldet sich beim
    // Zurückkommen selbst als gelesen.
    const offen = istAboniert(nachricht.channel_id);
    if (offen && siehtHin()) {
      readState.markRead(nachricht.channel_id, anker);
      continue;
    }
    readState.incUnread(nachricht.channel_id, anker);
    if (stumm || (gruppe && privateGruppen.eigenesStumm(gruppe, me))) continue;
    // Toast/Ton/In-Page-Benachrichtigung — zieht mit `dm_bump` gleich (Bughunt
    // Runde 4, Befund 1). Bei offenem Gespräch ohne den Toast (s.
    // `postfachBenachrichtigung.ts`).
    meldeNeueZustellung(nachricht, gruppe?.name ?? null, offen);
  }
}
