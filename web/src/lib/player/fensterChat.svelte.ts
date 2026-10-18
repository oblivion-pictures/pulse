/**
 * Stream-Chat als Seitenleiste im Sprachkanal — für Ströme, die im eigenen
 * Player-Fenster laufen.
 *
 * Bis 2026-10-19 öffnete „Chat öffnen“ im Fenster den Chat an der Kachel. Seit
 * die Kachel eines Fenster-Stroms aus dem Raster verschwindet
 * (`StreamGrid.svelte`), gibt es diese Stelle nicht mehr: der Wunsch landet
 * deshalb hier, und `StreamFensterChat.svelte` in `VoiceChannelView` zeigt ihn.
 * Gesetzt wird er vom `WhepPlayer`, der die Fenster-Sitzung hält und den
 * Wunsch aus dem Fenster ohnehin schon zählt (`nativeChatRequests`).
 *
 * Ein Wunsch für alle Kanäle, nicht einer je Kanal: das Fenster holt die App
 * nach vorne, und der Zuschauer erwartet genau EINEN Chat — den, dessen Knopf
 * er gerade gedrückt hat.
 */
import { nativePlayerSessions } from './store.svelte';
import { offeneFenster, seitenleistenStreamer, type ChatWunsch } from './imFenster';

let wunsch = $state<ChatWunsch | null>(null);

export const fensterChat = {
  /** Der rohe Wunsch — der Host navigiert daran in den Kanal. */
  get wunsch(): ChatWunsch | null {
    return wunsch;
  },
  /** Streamer, dessen Chat in `channelId` als Seitenleiste offen ist. */
  streamerIn(channelId: string): string | null {
    const w = wunsch;
    if (!w) return null;
    return seitenleistenStreamer(w, channelId, nativePlayerSessions.fuerHost(w.channelId, w.userId));
  },
  oeffnen(channelId: string, userId: string): void {
    // Immer ein neues Objekt, auch für denselben Streamer: der Host navigiert
    // bei jeder Änderung, und das zweite Drücken soll genauso wirken.
    wunsch = { channelId, userId };
  },
  schliessen(): void {
    wunsch = null;
  },
  /**
   * Wunsch verwerfen, sobald kein Fenster dieses Streamers mehr läuft. Ohne
   * das bliebe er liegen, und die Seitenleiste ginge beim nächsten Fenster
   * desselben Streamers ungefragt wieder auf. Läuft als Effect im
   * Hintergrund-Host, der unabhängig von der Navigation lebt.
   */
  aufraeumen(): void {
    const w = wunsch;
    if (w && offeneFenster(nativePlayerSessions.fuerHost(w.channelId, w.userId)).length === 0) {
      wunsch = null;
    }
  }
};
