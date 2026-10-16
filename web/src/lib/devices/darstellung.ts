/**
 * Standplatz-Geräte — wie ein Zustand aussieht und wo ein Gerät wohnt.
 *
 * Drei Stellen zeigen dasselbe Gerät (Kanalliste, Mitgliederliste,
 * Geräteansicht), und ohne diese Datei entstand die Abbildung
 * „Zustand → Farbe/Text" in jeder von ihnen neu. Beim ersten Mal ist das
 * Bequemlichkeit, beim dritten Mal laufen die Farben auseinander — und die
 * Farbe ist hier keine Zierde: sie beantwortet „kann ich diesen Rechner jetzt
 * übernehmen".
 */

import type { Device } from '$lib/api/devices';
import { deviceStore } from '$lib/devices/store.svelte';
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { m } from '$lib/paraglide/messages.js';
import {
  istGeraetestrom,
  ohneVerborgene,
  verborgenePlaetze,
  zeilenZustand,
  type Punkt,
  type ZeilenZustand,
} from './zugang';

/**
 * Wie die Zeile dieses Geräts für den angemeldeten Nutzer aussieht — die
 * Regel steht in `zugang.ts`, hier kommen nur die Store-Daten dazu (die
 * eigene Kennung auf DIESEM Server und ob das Gerät gerade sendet).
 */
export function zeileFuer(device: Device): ZeilenZustand {
  return zeilenZustand(device, currentServerUserId(), geraetSendet(device, device.channel_id));
}

/**
 * Farbe des Zustandspunkts.
 *
 * Bereit ist das einzige Grün — und seit 2026-10-16 nur für den, der den
 * Rechner auch steuern darf (oder ihn besitzt). Wer nicht freigegeben ist,
 * sieht ein waches Gerät als neutralen Punkt (`online`). Belegt ist kein
 * Fehler, aber auch keine Einladung, und offline ist schlicht still.
 */
export function punktKlasse(punkt: Punkt): string {
  if (punkt === 'bereit') return 'bg-emerald-500';
  if (punkt === 'belegt') return 'bg-amber-500';
  if (punkt === 'online') return 'bg-text-muted';
  return 'bg-text-muted/40';
}

/**
 * Zustand als Text. `wer` ist der Name des Steuernden, sofern bekannt — nur
 * die Mitgliederliste hat Platz dafür, die Kanalliste zeigt den kurzen Text.
 */
export function zustandsText(punkt: Punkt, wer?: string | null): string {
  if (punkt === 'belegt') {
    return wer ? m.device_member_busy_with({ user: wer }) : m.device_state_busy();
  }
  if (punkt === 'bereit') return m.device_state_ready();
  if (punkt === 'online') return m.device_state_online();
  return m.device_state_offline();
}

/**
 * Wo ein Gerät wohnt.
 *
 * Der Kanal in der Adresse bleibt der Standplatz — das Gerät gehört dorthin,
 * und die Kanalliste hebt beides zusammen hervor. Dass die Kennung als
 * Abfrageteil (`?device=`) und nicht als eigener Pfad steht, hält die
 * Geräteansicht in derselben Ansicht wie den Kanal: Zurück-Knopf, Neuladen und
 * Verlinken tun, was man erwartet, ohne eine zweite Route mit derselben
 * Umgebung.
 */
export function geraetPfad(device: Device): string {
  return `/app/guilds/${device.guild_id}/channels/${device.channel_id}?device=${device.id}`;
}

/**
 * Sendet in diesem Kanal in Wahrheit nur das **Gerät** dieses Nutzers?
 *
 * Der Strom eines Standplatz-Geräts läuft unter dem Konto seines Besitzers — im
 * Streaming-Weg gibt es keine Geräte-Kennung (`stream/starten.ts`). Ungefiltert
 * heisst das: das LIVE-Abzeichen erscheint **zweimal**, einmal am Rechner und
 * einmal am Menschen, der dabei nicht einmal im Kanal sein muss.
 *
 * **Bis 2026-08-16 wurde das geraten** — *steht ein Gerät dieses Besitzers im
 * Kanal, gehört ein Strom dieses Kontos dorthin*. Die Vermutung prüfte nur, OB
 * ein Gerät dort steht, nicht ob es sendet. Klickte der Besitzer an seinem
 * eigenen Rechner auf „Live", wanderte das Abzeichen an den Standplatz, der
 * nichts tat, und verschwand bei dem, der wirklich sendete: das falsche
 * Abzeichen am falschen Ort.
 *
 * Jetzt sagt das Gerät selbst, auf welchen Plätzen es sendet
 * (`device_streams` → `Device.stream_slots`), und hier wird verglichen. Der
 * Mensch verliert sein Abzeichen nur, wenn **jeder** seiner Ströme in diesem
 * Kanal von einem seiner Geräte kommt; überträgt er zusätzlich selbst, behält
 * er es, und beide Abzeichen stimmen.
 *
 * Meldet ein Gerät nichts (ältere Fassung), bleibt es beim Abzeichen am
 * Menschen — der harmlosere der beiden Fehler.
 *
 * **Ein geteilter Bildschirm über Voice ist davon nicht betroffen** — der
 * läuft über LiveKit und wird an den Aufrufstellen getrennt geführt.
 */
export function stromGehoertGeraet(channelId: string, userId: string): boolean {
  const plaetze = new Set(
    deviceStore.alleImKanal(channelId, userId).flatMap((d) => d.stream_slots ?? []),
  );
  if (plaetze.size === 0) return false;
  const eigene = streamPresence.streamsIn(channelId).filter((s) => s.user_id === userId);
  // Kein Strom: nichts zuzuordnen. Ohne diese Zeile gälte „alle gehören dem
  // Gerät" für die leere Menge — und der Mensch verlöre ein Abzeichen, das er
  // gar nicht hat.
  if (eigene.length === 0) return false;
  return eigene.every((s) => plaetze.has(s.slot));
}

/**
 * Die Gegenseite: sendet DIESES Gerät gerade selbst?
 *
 * Gehört zwingend neben `stromGehoertGeraet()` — die beiden bilden zusammen
 * eine Aufteilung, kein Nebeneinander. Der Mensch gibt sein Abzeichen genau
 * dann ab, wenn das Gerät es bekommt, und für jeden Strom leuchtet genau eine
 * der beiden Zeilen.
 *
 * **Warum das hier steht und nicht in der Gerätezeile**: dort stand bis zum
 * 2026-08-18 die alte Vermutung „läuft in diesem Kanal irgendein Strom des
 * Besitzers?". Als die Menschen-Seite auf die gemeldeten Plätze umgestellt
 * wurde (6889e66a), blieb die Gerätezeile darauf sitzen — und beide Abzeichen
 * leuchteten gleichzeitig, sobald jemand von Hand übertrug, während sein
 * Standplatz nur danebenstand. Solange beide Bedingungen in derselben Datei
 * liegen, kann das nicht wieder auseinanderlaufen.
 */
export function geraetSendet(device: { owner_user_id: string; stream_slots?: number[] }, channelId: string): boolean {
  const plaetze = new Set(device.stream_slots ?? []);
  // Meldet das Gerät nichts, sendet es auch nichts. Ein Gerät ohne gemeldete
  // Plätze ist der Normalfall (nie geweckt) — nicht etwa „alles gehört ihm".
  if (plaetze.size === 0) return false;
  return streamPresence
    .streamsIn(channelId)
    .some((s) => s.user_id === device.owner_user_id && plaetze.has(s.slot));
}

/**
 * Die Ströme von `userId` in diesem Kanal, die der angemeldete Nutzer öffnen
 * darf — ohne die Plätze seiner Geräte, denen er gerade nicht zusehen darf
 * (`zugang.ts::verborgenePlaetze`: Besitzer immer, sonst nur, solange jemand
 * steuert). Der Server weist einen solchen Strom ohnehin ab (403 an `/whep`);
 * ihn gar nicht erst anzubieten, erspart eine Kachel, die nie Bild bekommt.
 *
 * Alle Wege, die Ströme eines Menschen öffnen oder ein LIVE an ihm zeigen,
 * gehen hierüber: `hqTile.ts::chooseHqForUser`, die Teilnehmer-Kachel, die
 * Mitgliederliste, der Aktivitätskopf und das Selbst-Öffnen weiterer Plätze
 * in `VoiceChannelView`.
 */
export function sichtbareStroeme(channelId: string, userId: string) {
  const verborgen = verborgenePlaetze(deviceStore.alleImKanal(channelId, userId), currentServerUserId());
  const eigene = streamPresence.streamsIn(channelId).filter((s) => s.user_id === userId);
  return ohneVerborgene(eigene, verborgen);
}

/** Kommt der Strom von `userId` auf `slot` in diesem Kanal von einem seiner
 *  Geräte? Für den Anfrage-Knopf im Player, der bei Geräten wegfällt. */
export function stromIstGeraetestrom(channelId: string, userId: string, slot: number): boolean {
  return istGeraetestrom(deviceStore.alleImKanal(channelId, userId), slot);
}
