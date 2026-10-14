/**
 * Kommt der eigene HQ-Stream beim Server an? Eine Wache, die nachfragt.
 *
 * **Warum es das gibt.** Der Sidecar meldet `live`, sobald die WHIP-Antwort da
 * ist, also bevor der Medienweg (ICE) steht. Die Streamer-Anzeige hängt allein
 * an diesem Signal, und der 20-s-Startwächter in `state.svelte.ts` gilt nur für
 * `starting`. Am 2026-10-14 stand ein Stream so 2,5 Minuten auf „Live", während
 * beim Server kein Paket ankam (ICE kam auf einem Self-Host nie zustande): kein
 * Fehler, kein Hinweis, nur Zuschauer, die nichts sahen.
 *
 * **Woran „angekommen" gemessen wird.** Am Server selbst: Nur der Poller von
 * media-svc meldet einen Stream als live, und der sieht ihn erst, wenn MediaMTX
 * den Pfad als bereit führt, also wenn wirklich Daten fliessen. Gefragt wird
 * per REST (`GET /guilds/{id}/stream-state`) beim Server, an den das Sende-Token
 * ging, nicht über die WS-Präsenz: `stream_state` kommt nur über die Verbindung
 * des AKTIVEN Servers an, und wer während des Streams die Community wechselt,
 * bekäme sonst einen Fehlalarm.
 *
 * **Warum 20 s.** Seit dem Weckruf (`dcc_media_svc/weckruf.py`, 2026-10-09)
 * meldet der Server einen gesunden Stream etwa eine halbe Sekunde nach dem
 * ersten Paket. Ältere Server pollen im Leerlauf nur alle 30 s; dort kann die
 * Warnung zu früh kommen — sie verschwindet dann beim nächsten Nachfragen von
 * selbst.
 *
 * **Nur Hinweis, kein Abbruch.** ICE kann sich verspätet doch noch einigen;
 * den Stream zu beenden, nähme dem Nutzer die Wahl. Ein Fehlschlag der Abfrage
 * selbst (Netz, 5xx) gilt als „weiss nicht" und warnt nicht.
 */

import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { chatApi } from '$lib/api/chat';
import { guilds } from '$lib/stores/guilds.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { melde } from '$lib/diagnose/app-diagnose';
import { istAngekommen } from './ankunft';

const ERSTE_FRAGE_MS = 20_000;
const NACHFRAGE_MS = 10_000;
/** Danach fragt die Wache nicht mehr nach; eine stehende Warnung bleibt stehen. */
const AUFGEBEN_NACH_MS = 120_000;

type Ziel = {
  kanalId: string;
  serverId: string;
  guildId: string;
  nutzerId: string;
};

const ziele = new Map<number, Ziel>();
const uhren = new Map<number, ReturnType<typeof setTimeout>>();

function toastId(platz: number): string {
  return `stream-ankunft-${platz}`;
}

/**
 * Beim Start merken, wohin der Stream geht. `serverId` ist der Server, an den
 * das Sende-Token ging — der Aufrufer liest ihn VOR dem Token-Abruf
 * (`chatApi.getStreamToken` nimmt den dann aktiven), damit ein Serverwechsel
 * während des Abrufs die Wache nicht beim falschen Server nachfragen lässt.
 * Im P2P-Modus NICHT rufen: der Stream geht dort nie an den Server, und die
 * Wache meldete jedes Mal einen Fehlalarm.
 */
export function ankunftZielMerken(platz: number, kanalId: string, serverId: string): void {
  const guildId = guilds.guildIdForChannel(kanalId);
  const nutzerId = currentServerUserId();
  if (!guildId || !nutzerId || !serverId) {
    ziele.delete(platz);
    return;
  }
  ziele.set(platz, { kanalId, serverId, guildId, nutzerId });
}

/** Der Sidecar meldet `live`: die Uhr bis zur ersten Nachfrage starten. */
export function ankunftWacheStarten(platz: number): void {
  if (!ziele.has(platz)) return;
  stellen(platz, ERSTE_FRAGE_MS, Date.now());
}

/** Stream zu Ende (gleich welcher Weg): Uhr ab, Warnung weg, Ziel vergessen. */
export function ankunftWacheBeenden(platz: number): void {
  const uhr = uhren.get(platz);
  if (uhr !== undefined) clearTimeout(uhr);
  uhren.delete(platz);
  ziele.delete(platz);
  toast.dismiss(toastId(platz));
}

function stellen(platz: number, nachMs: number, beginn: number): void {
  const alt = uhren.get(platz);
  if (alt !== undefined) clearTimeout(alt);
  uhren.set(
    platz,
    setTimeout(() => void nachfragen(platz, beginn), nachMs),
  );
}

/** `null` = weiss nicht (Netz, 5xx): nicht warnen, nur später noch einmal fragen. */
async function beimServerAngekommen(
  ziel: Ziel,
  platz: number,
): Promise<boolean | null> {
  try {
    const { stream_states } = await chatApi.guildStreamState(ziel.guildId, {
      serverId: ziel.serverId,
    });
    return istAngekommen(stream_states, ziel.kanalId, ziel.nutzerId, platz);
  } catch {
    return null;
  }
}

async function nachfragen(platz: number, beginn: number): Promise<void> {
  uhren.delete(platz);
  const ziel = ziele.get(platz);
  if (!ziel) return;
  const angekommen = await beimServerAngekommen(ziel, platz);
  // Während der Abfrage beendet oder neu gestartet → diese Antwort gilt nicht mehr.
  if (ziele.get(platz) !== ziel) return;
  if (angekommen) {
    ziele.delete(platz);
    toast.dismiss(toastId(platz));
    return;
  }
  if (angekommen === false) {
    toast.warning(m.stream_ankunft_fehlt(), {
      id: toastId(platz),
      description: m.stream_ankunft_fehlt_desc(),
      duration: Number.POSITIVE_INFINITY,
    });
    melde('stream', 'stream_ankunft_fehlt', 'Server sieht den Stream nicht', {
      slot: platz,
      kanal: ziel.kanalId,
    });
  }
  if (Date.now() - beginn < AUFGEBEN_NACH_MS)
    stellen(platz, NACHFRAGE_MS, beginn);
}
