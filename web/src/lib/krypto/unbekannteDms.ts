/**
 * Eine BRANDNEUE DM vor dem Öffnen bekannt machen (Push-Bughunt 2026-10-21,
 * Befund 3).
 *
 * `zustellungOeffnen.ts` sichert eine Olm-Sitzung nur noch, wenn der Kanal
 * lokal bekannt ist — sonst liesse sich die Nachricht nach einer
 * gescheiterten Ablage nie wieder öffnen. Bis dahin machte gerade dieser
 * Fehlschlag eine neue DM bekannt: die Nachricht wurde trotzdem angezeigt,
 * und erst die Anzeige trug den Kanal in die DM-Liste ein
 * (`postfachVerbuchen.ts`, `upsertFromEncrypted`) — im Verlauf fehlte sie.
 * Jetzt fragt der Zyklus VOR dem Öffnen die DM-Liste beim Server nach
 * (`directMessages.hydrate`, `GET /dm-channels`), sobald eine
 * Olm-Zustellung in einem unbekannten Kanal liegt.
 *
 * Je Kanal nur einmal erfolgreich nachgefragt: bleibt er danach unbekannt
 * (keine DM von uns, etwa eine Gruppe, deren Liste noch fehlt), liefe sonst
 * jeder Zyklus eine Anfrage, solange die Zustellung liegt. Die Frist hält
 * den Zyklus nicht länger auf als eine Postfach-Anfrage
 * (`api/postfach.ts::POSTFACH_FRIST_MS`); die Anfrage selbst läuft dann im
 * Hintergrund zu Ende.
 */
import type { PostfachZustellung } from '../api/postfach';
import { POSTFACH_FRIST_MS } from '../api/postfach';
import { directMessages } from '../stores/directMessages.svelte';
import { istLokalerKanal } from '../verlauf/kanalArt';
import { ART_GRUPPENNACHRICHT } from './gruppe/gruppenNutzlast';
import { melde } from '../diagnose/app-diagnose';

const schonNachgefragt = new Set<string>();

export async function unbekannteDmsNachladen(
  zustellungen: readonly PostfachZustellung[]
): Promise<void> {
  const unbekannt = zustellungen
    .filter((z) => z.art !== ART_GRUPPENNACHRICHT && !istLokalerKanal(z.channel_id))
    .map((z) => z.channel_id);
  if (unbekannt.every((k) => schonNachgefragt.has(k))) return;
  let uhr: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      directMessages.hydrate(),
      new Promise<never>((_, ablehnen) => {
        uhr = setTimeout(() => ablehnen(new Error('Frist abgelaufen')), POSTFACH_FRIST_MS);
      })
    ]);
    for (const k of unbekannt) schonNachgefragt.add(k);
  } catch (err) {
    // Kein Abbruch: die Zustellungen dieser Kanäle bleiben dann nur liegen.
    melde('postfach', 'dm_liste_nachladen', `DM-Liste nicht nachgeladen: ${String(err)}`);
  } finally {
    clearTimeout(uhr);
  }
}
