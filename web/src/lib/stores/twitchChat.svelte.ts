/**
 * Twitch-Live-Chat je Kanal — reaktive Hülle um den Connector
 * (`watch/twitchChatConnector.ts`), der die eigentliche anonyme IRC-WebSocket
 * hält. Referenzgezählt: mehrere Kacheln im SELBEN Fenster, die denselben
 * Kanal offen haben, teilen eine Verbindung; das entkoppelte Popup-Fenster
 * ist ein eigener JS-Kontext und damit bewusst eine eigene Verbindung.
 *
 * Der Chat ist rein live und flüchtig: kein Backfill, kein Persistieren —
 * fällt der letzte Zuschauer-Effekt weg (Reiter zu, Party-Ende, Quelle
 * gewechselt), wird die Verbindung getrennt UND der Kanal-Eintrag geräumt.
 * Eingespeist wird per acquire(channel) → Release-Funktion (Effekt-Cleanup).
 */

import { TwitchChatConnector, MAX_BUFFER, type TwitchChatStatus } from '$lib/watch/twitchChatConnector';
import type { TwitchChatMessage } from '$lib/watch/twitchIrc';

type Entry = { conn: TwitchChatConnector; refs: number };

class TwitchChatStore {
  byChannel = $state<Record<string, TwitchChatMessage[]>>({});
  statusByChannel = $state<Record<string, TwitchChatStatus>>({});

  private entries = new Map<string, Entry>();

  /** Verbindung anfordern. Gibt die Freigabe zurück (Effekt-Cleanup). */
  acquire(channel: string): () => void {
    const key = channel.toLowerCase();
    let entry = this.entries.get(key);
    if (!entry) {
      const conn = new TwitchChatConnector(key);
      conn.onMessages = (batch) => this.append(key, batch);
      conn.onStatus = (status) => {
        this.statusByChannel = { ...this.statusByChannel, [key]: status };
      };
      entry = { conn, refs: 0 };
      this.entries.set(key, entry);
      conn.start();
    }
    entry.refs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.refs--;
      if (entry.refs > 0) return;
      entry.conn.stop();
      this.entries.delete(key);
      // Nachrichten und Status mit der Verbindung begraben — Twitch-Chat
      // hat keine Historie, ein Neustart startet bei null.
      const { [key]: _msgs, ...restMsgs } = this.byChannel;
      this.byChannel = restMsgs;
      const { [key]: _st, ...restSt } = this.statusByChannel;
      this.statusByChannel = restSt;
    };
  }

  private append(key: string, batch: TwitchChatMessage[]): void {
    const existing = this.byChannel[key] ?? [];
    const next = [...existing, ...batch];
    if (next.length > MAX_BUFFER) next.splice(0, next.length - MAX_BUFFER);
    this.byChannel = { ...this.byChannel, [key]: next };
  }

  for(channel: string): TwitchChatMessage[] {
    return this.byChannel[channel.toLowerCase()] ?? [];
  }

  statusOf(channel: string): TwitchChatStatus | undefined {
    return this.statusByChannel[channel.toLowerCase()];
  }

  /** Server-Wechsel / Abmelden — Pendant zu ``watchChat.clearAll()``. */
  clearAll(): void {
    for (const entry of this.entries.values()) entry.conn.stop();
    this.entries.clear();
    this.byChannel = {};
    this.statusByChannel = {};
  }
}

export const twitchChat = new TwitchChatStore();
