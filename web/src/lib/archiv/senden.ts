/**
 * Einlieferung in den Server-Archiv (Übergabe 2026-10-04, §5): JEDE
 * verschlüsselte Nachricht wird nach erfolgreicher Zustellung zusätzlich
 * verschlüsselt beim Server abgelegt (120 Tage). Fire-and-forget — das
 * Archiv darf die Nachricht nie aufhalten; ein Fehlschlag wird still
 * (console.warn) und der Verlauf bleibt lokal die wahre Kopie.
 *
 * Reihenfolge im Absendeweg: NACH dem `verlaufSpeichernPflicht`, VOR dem
 * Return (`krypto/senden.ts` für DMs, `krypto/gruppe/senden.ts` für
 * private Gruppen — Michaels Entscheidung „Gruppen und Privatchats“,
 * 2026-10-05).
 *
 * Die Wraps für die anderen Teilnehmer reisen JE Sendung mit, aber nur
 * einmal je Sitzung berechnet (`kanalSchluessel.ts`): hatte die Gegenseite
 * beim ersten Senden noch keinen Archiv-Public-Key, richtet ein späteres
 * Senden ihren Zugang nach — ohne Extra-Endpunkt und ohne Existenz-Rückfrage.
 *
 * Löscht der Autor eine eigene verschlüsselte Nachricht, liefert er dazu
 * eine Grabstein-Zeile ein (`archiviereGrabstein`, Format in `zeile.ts`) —
 * sonst holte jedes Frischgerät die Nachricht 120 Tage lang aus dem Archiv
 * zurück.
 */

import { auth } from '$lib/stores/auth.svelte';
import type { Message } from '$lib/api/types';
import { archivEinliefern, archivKanalSchluessel, archivPubkeys } from '$lib/api/archiv';
import { erzeugeZufallsId, kanalSchluesselHolen, type ArchivPubkeyZiel } from './kanalSchluessel';
import { verschluessleZeile } from './krypto';
import { baueGrabsteinKlar, baueZeilenKlar } from './zeile';
import { archivPaar } from './konto';

/** Eine laufende Einlieferung je Kanal — zwei schnelle Nachrichten serialisieren. */
const laufend = new Map<string, Promise<void>>();

/**
 * Archiviert eine GESENDETE verschlüsselte DM. Wirft nie.
 */
export function archiviereGesendet(kanalId: string, empfaengerId: string, nachricht: Message): void {
  anstellen(kanalId, async () => {
    // NUR den Partner fragen — die Route erlaubt nur echte DM-Partner,
    // und die eigene Id wäre ihr eigener Partner nie (404, stiller Abbruch).
    const pubkeys = await archivPubkeys([empfaengerId]);
    const fremd = pubkeys[empfaengerId];
    return fremd ? [{ id: empfaengerId, pubkey: fremd }] : [];
  }, () => baueZeilenKlar(nachricht));
}

/**
 * Archiviert eine GESENDETE private Gruppennachricht. Wirft nie.
 * `mitgliederIds` ist die frische Mitgliederliste vom Sendeweg — nur für
 * sie darf der Server Public-Keys herausgeben (Kanal-Skop).
 */
export function archiviereGruppeGesendet(
  kanalId: string,
  mitgliederIds: string[],
  nachricht: Message
): void {
  anstellen(kanalId, async () => {
    const eigeneId = auth.user?.id;
    const andere = mitgliederIds.filter((m) => m !== eigeneId);
    if (andere.length === 0) return [];
    const pubkeys = await archivPubkeys(andere, kanalId);
    return andere.filter((m) => pubkeys[m]).map((m) => ({ id: m, pubkey: pubkeys[m]! }));
  }, () => baueZeilenKlar(nachricht));
}

/**
 * Liefert die Grabstein-Zeile für eine EIGENE gelöschte Nachricht ein
 * (`kennung` = ihre kanonische Kennung). Nur in einen Kanal, für den dieses
 * Konto schon einen Schlüssel hat — ohne ihn hat es dort nie etwas
 * archiviert, und es gibt nichts zu löschen. Wirft nie.
 */
export function archiviereGrabstein(kanalId: string, kennung: string): void {
  anstellen(kanalId, null, (autorId) =>
    baueGrabsteinKlar(kennung, autorId, new Date().toISOString())
  );
}

/** Gemeinsamer Kern: serialisieren, entsperren, Schlüssel + Wraps besorgen,
 *  Zeile verschlüsseln, alles in EINER Anfrage einliefern. Wirft nie.
 *  `zieleErmitteln === null`: nur mit dem schon vorhandenen Kanal-Schlüssel,
 *  ohne Erstanlage und ohne neue Wraps. */
function anstellen(
  kanalId: string,
  zieleErmitteln: (() => Promise<ArchivPubkeyZiel[]>) | null,
  zeileKlar: (kontoId: string) => Uint8Array
): void {
  const vorher = laufend.get(kanalId) ?? Promise.resolve();
  const lauf = vorher
    .then(async () => {
      const kontoId = auth.user?.id;
      if (!kontoId) return;
      const paar = await archivPaar(kontoId);
      if (!paar) return; // Archiv auf diesem Gerät nicht entsperrt — kein Zwang
      if (zieleErmitteln === null && !(await archivKanalSchluessel(kanalId))) return;
      const ziele = zieleErmitteln === null ? [] : await zieleErmitteln();
      const { schluessel, wraps } = await kanalSchluesselHolen(kanalId, paar, ziele);
      await archivEinliefern(
        [
          {
            id: erzeugeZufallsId(),
            channel_id: kanalId,
            nutzlast_b64: bytesZuB64(await verschluessleZeile(schluessel, zeileKlar(kontoId)))
          }
        ],
        wraps
      );
    })
    .catch((e) => console.warn('[archiv] Einlieferung fehlgeschlagen', e))
    .finally(() => {
      if (laufend.get(kanalId) === lauf) laufend.delete(kanalId);
    });
  laufend.set(kanalId, lauf);
}

function bytesZuB64(bytes: Uint8Array): string {
  let binär = '';
  for (const b of bytes) binär += String.fromCharCode(b);
  return btoa(binär);
}
