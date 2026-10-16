/**
 * „Diesen Bildschirm schließen" — die Seite des STEUERNDEN.
 *
 * Der Knopf sitzt im Menü am Griff des Player-Fensters
 * (`streaming/pulse-player/src/overlay/fernbedienung.rs`); das Fenster meldet
 * nur seine eigene Nummer (`player:remoteScreenClose`). Welcher Platz das ist,
 * steht hier in der Fenster-Registry — dieselbe Auflösung wie beim
 * Anfrage-Knopf (`nativePlayerSessions.nachFenster`).
 *
 * Zwei Dinge geschehen, und beide hier: das Gerät wird gebeten, den Platz nicht
 * mehr zu übertragen (`schirm_zu`, `$lib/devices/schirmZu.ts`), und Fenster
 * samt Kachel gehen sofort zu — ohne auf das Ende des Stroms zu warten. Kennt
 * der Server oder das Gerät das Signal noch nicht (ältere Fassung), bleibt
 * genau das übrig, was das Schließen eines Fensters bisher bewirkte: das
 * Fenster ist zu, der Rechner überträgt weiter.
 *
 * Die übrigen Fenster und die Sitzung bleiben: das Menü bietet den Knopf nur
 * an, solange ausser diesem noch ein Bildschirm läuft.
 */

import { nativePlayerSessions } from '$lib/player/store.svelte';
import { nativeWindowRequests } from '$lib/player/wuensche.svelte';
import { openedTiles } from '$lib/stream/openedTiles.svelte';
import { hqTileId } from '$lib/stream/hqTile';
import { abbestellt } from '$lib/stream/abbestellt';
import { remoteSession } from './session.svelte';
import { SCHIRM_ZU } from './schirmZuRegel';

export function bildschirmSchliessen(fensterSitzung: number): void {
  if (remoteSession.phase !== 'active' || remoteSession.role !== 'controller') return;
  const s = nativePlayerSessions.nachFenster(fensterSitzung);
  // Nur ein Fenster DIESER Sitzung — ein fremdes (ein anderer Streamer im
  // Kanal) darf dem Gerät nichts abbestellen.
  if (!s || s.channelId !== remoteSession.channelId || s.userId !== remoteSession.peerUserId) {
    return;
  }
  remoteSession.signal(SCHIRM_ZU, { slot: s.slot });
  const kachel = hqTileId(s.userId, s.slot);
  // Der Server führt den Strom noch bis zu 3 s als laufend — ohne Sperre
  // öffnete die Automatik die Kachel sofort wieder (`stream/abbestellt.ts`).
  abbestellt.abbestellen(s.channelId, kachel, Date.now());
  nativeWindowRequests.release(s.channelId, s.userId, s.slot);
  openedTiles.close('hq', s.channelId, kachel);
  nativePlayerSessions.close(s.channelId, s.userId, s.slot);
}
