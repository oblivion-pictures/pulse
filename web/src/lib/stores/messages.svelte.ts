import type { Message, ReactionAggregate } from '$lib/api/types';
import { dispatchingUserId } from './currentServerUser';
import { compareSnowflakeId } from '$lib/utils/snowflake';
import { clearBlobCache } from '$lib/attachments/blobCache';
import {
  einfuegen,
  entfernen,
  ersetzeNachricht,
  kappen,
  kryptoIdsVon,
  letzteServerId,
  lueckeZusammenfuehren,
  ohneGrabsteine,
  vorneAnfuegen
} from '$lib/nachrichten/listenKern';
import {
  abgleichen,
  pinSpiegel,
  pinsFortschreiben,
  reaktionAnwenden
} from '$lib/nachrichten/aenderungenKern';
import { ZuletztBenutzt, ohne } from '$lib/nachrichten/kanalCache';
import { Grabsteine } from '$lib/nachrichten/grabsteine';

class MessageStore {
  // Newest at the end. We dedupe on `id` and merge `nonce` echoes.
  byChannel = $state<Record<string, Message[]>>({});
  loadedChannels = $state<Record<string, boolean>>({});
  // Pin-Liste pro Kanal (max. 50, ältester Pin zuerst). Getrennt vom
  // Nachrichtenfenster, weil ein Pin außerhalb der geladenen Historie
  // liegen kann. `undefined` = noch nicht geladen, `[]` = leer.
  pinsByChannel = $state<Record<string, Message[] | undefined>>({});
  // Track confirmed (server-persisted, non-tmp) nonces for O(1) lookup.
  private confirmedNonces = new Set<string>();
  // Track message IDs in the current channel for O(1) dedup during upsert.
  private messageIds = $state<Record<string, Set<string>>>({});
  // Kanonische (krypto) IDs je Kanal — dasselbe Spiel für die geraete-
  // übergreifende `krypto_id`: dieselbe logische Nachricht trägt je Gerät
  // eine andere lokale ID (Empfangs-ID hier, Archiv-Kopie des anderen
  // Geräts beim Hochscrollen). Nur über die kanonische ID erkennt der
  // Store sie als dieselbe Nachricht.
  private kryptoIds = $state<Record<string, Set<string>>>({});
  // `krypto_id`s gelöschter Nachrichten, überleben Kappen und Neuladen (`grabsteine.ts`).
  private grabsteine = new Grabsteine();
  // LRU order of cached channels, evicts beyond MAX_CACHED_CHANNELS (`nachrichten/kanalCache.ts`).
  private lru = new ZuletztBenutzt();

  for(channelId: string): Message[] {
    return this.byChannel[channelId] ?? [];
  }

  // Mit VList-Virtualisierung ist die DOM-Größe vom Store entkoppelt — das CAP
  // schützt nur den Arbeitsspeicher. 5000 deckt selbst sehr tiefe Historie ab,
  // die via Infinite-Scroll-Up nachgeladen wird; älteste werden geprunt.
  private static readonly CAP = 5000;
  /** Max number of channels kept in the message cache at once. */
  private static readonly MAX_CACHED_CHANNELS = 15;

  /** Evict until within the cap: never-opened first, then LRU, never the last-touched. */
  private enforceChannelCap(): void {
    const max = MessageStore.MAX_CACHED_CHANNELS;
    for (const cid of this.lru.zuRaeumen(Object.keys(this.byChannel), max)) this.clearChannel(cid);
  }

  /** Mark a channel as the most-recently-active (called when the user opens
   *  it, even if no new messages loaded) and enforce the cache cap. */
  touch(channelId: string): void {
    if (!channelId) return;
    this.lru.anheben(channelId);
    this.enforceChannelCap();
  }

  /** Vergisst die bestätigten Nonces nicht mehr gehaltener Nachrichten (gekappt
   *  oder Kanal geräumt), damit die Dedup-Menge nicht unbegrenzt wächst. */
  private vergiss(verworfen: Message[]): void {
    for (const m of verworfen) if (m.nonce) this.confirmedNonces.delete(m.nonce);
  }

  /** Merkt die Nonce einer vom Server bestätigten (nicht `tmp-`) Nachricht. */
  private bestaetige(m: Message): void {
    if (m.nonce && !m.id.startsWith('tmp-')) this.confirmedNonces.add(m.nonce);
  }

  setInitial(channelId: string, msgs: Message[]): void {
    // Backend returns descending; flip for chat-bottom display. Gelöschtes bleibt draußen.
    const begraben = this.grabsteine.fuer(channelId);
    const sorted = kappen(
      [...ohneGrabsteine(msgs, begraben)].sort((a, b) => compareSnowflakeId(a.id, b.id)),
      MessageStore.CAP
    ).liste;
    this.byChannel = { ...this.byChannel, [channelId]: sorted };
    this.loadedChannels = { ...this.loadedChannels, [channelId]: true };
    // Populate the ID set for O(1) dedup during upsert.
    this.messageIds = { ...this.messageIds, [channelId]: new Set(sorted.map((m) => m.id)) };
    this.kryptoIds = { ...this.kryptoIds, [channelId]: kryptoIdsVon(sorted, begraben) };
    this.touch(channelId);
  }

  /** Prepend older history (Infinite-Scroll-Up). `msgs` sind älter als der
   *  aktuelle älteste Eintrag. Dedupes by id, fügt id-sortiert vorne ein,
   *  prunt auf CAP. Gibt true zurück falls etwas dazukam (Aufrufer nutzt
   *  <limit um das Historie-Ende zu erkennen). */
  prepend(channelId: string, msgs: Message[]): boolean {
    if (!msgs.length) return false;
    const list = this.byChannel[channelId] ?? [];
    const ids = this.messageIds[channelId] ?? new Set(list.map((m) => m.id));
    const begraben = this.grabsteine.fuer(channelId);
    const krypto = this.kryptoIds[channelId] ?? kryptoIdsVon(list, begraben);
    const angefuegt = vorneAnfuegen(list, ids, krypto, msgs, MessageStore.CAP, begraben);
    if (!angefuegt) return false;
    this.vergiss(angefuegt.verworfen);
    this.byChannel = { ...this.byChannel, [channelId]: angefuegt.liste };
    this.messageIds = { ...this.messageIds, [channelId]: ids };
    this.kryptoIds = { ...this.kryptoIds, [channelId]: krypto };
    for (const m of angefuegt.neu) this.bestaetige(m);
    return true;
  }

  upsert(msg: Message): void {
    const list = this.byChannel[msg.channel_id] ?? [];
    const ids = this.messageIds[msg.channel_id] ?? new Set();
    // If the message has a nonce, try to replace a pending optimistic copy.
    if (msg.nonce) {
      const idxNonce = list.findIndex((m) => m.nonce === msg.nonce && m.id !== msg.id);
      if (idxNonce >= 0) {
        const next = list.slice();
        next[idxNonce] = msg;
        this.byChannel = { ...this.byChannel, [msg.channel_id]: next };
        // Update the ID set.
        ids.delete(list[idxNonce].id);
        ids.add(msg.id);
        this.messageIds = { ...this.messageIds, [msg.channel_id]: ids };
        // Krypto-Set mitführen — nur bei Abweichung ummelden. Die vorläufige
        // Kopie eines verschlüsselten Sendens (`vorlaeufigVerschluesselt.ts`)
        // hat keine `krypto_id`, die echte Nachricht schon (`senden.ts`).
        const kryptoAlt = list[idxNonce].krypto_id;
        const kryptoNeu = msg.krypto_id;
        if (kryptoAlt !== kryptoNeu) {
          const krypto = this.kryptoIds[msg.channel_id] ?? new Set();
          if (kryptoAlt) krypto.delete(kryptoAlt);
          if (kryptoNeu) krypto.add(kryptoNeu);
          this.kryptoIds = { ...this.kryptoIds, [msg.channel_id]: krypto };
        }
        this.bestaetige(msg);
        return;
      }
    }
    // Echo-Ersatz (Nonce) läuft OBEN — ein Skip in `einfuegen` trifft nur
    // Duplikate (über die Id und die kanonische ID).
    const begraben = this.grabsteine.fuer(msg.channel_id);
    const krypto = this.kryptoIds[msg.channel_id] ?? kryptoIdsVon(list, begraben);
    const eingefuegt = einfuegen(list, ids, krypto, msg, MessageStore.CAP, begraben);
    if (!eingefuegt) return;
    this.vergiss(eingefuegt.verworfen);
    this.byChannel = { ...this.byChannel, [msg.channel_id]: eingefuegt.liste };
    this.messageIds = { ...this.messageIds, [msg.channel_id]: ids };
    this.kryptoIds = { ...this.kryptoIds, [msg.channel_id]: krypto };
    this.bestaetige(msg);
  }

  /** Add an optimistic outgoing message — replaced by upsert on echo. */
  addOptimistic(msg: Message): void {
    this.upsert(msg);
  }

  /** Replace an existing message in place (edit). The server's reactions
   *  list is authoritative once present; if missing on the update payload
   *  we preserve the cached one so the UI doesn't blink. */
  update(msg: Message): void {
    this.ersetze(msg.channel_id, msg.id, (alt) => ({
      ...msg,
      reactions: msg.reactions ?? alt.reactions
    }));
  }

  /** Ersetzt eine geladene Nachricht durch `aendern(alt)`; `null` = nichts zu tun. */
  private ersetze(channelId: string, id: string, aendern: (alt: Message) => Message | null): void {
    const list = this.byChannel[channelId];
    const next = list && ersetzeNachricht(list, id, aendern);
    if (next) this.byChannel = { ...this.byChannel, [channelId]: next };
  }

  /** Hard-remove a deleted message from the local list. */
  remove(channelId: string, id: string): void {
    const pins = this.pinsByChannel[channelId];
    if (pins?.some((p) => p.id === id)) {
      // Gelöschte Nachricht löst serverseitig ihren Pin — hier nachziehen.
      this.pinsByChannel = { ...this.pinsByChannel, [channelId]: pins.filter((p) => p.id !== id) };
    }
    const list = this.byChannel[channelId];
    if (!list) return;
    const begraben = this.grabsteine.fuer(channelId);
    const ids = this.messageIds[channelId] ?? new Set(list.map((m) => m.id));
    const krypto = this.kryptoIds[channelId] ?? kryptoIdsVon(list, begraben);
    const next = entfernen(list, ids, krypto, begraben, id);
    if (!next) return;
    this.byChannel = { ...this.byChannel, [channelId]: next };
    this.messageIds = { ...this.messageIds, [channelId]: ids };
    this.kryptoIds = { ...this.kryptoIds, [channelId]: krypto };
  }

  /** Apply a delta to a message's reactions list. `delta` is +1 for add, -1
   *  for remove. `me` is set when this account is the reactor (see the
   *  ``dispatchingUserId`` note below). */
  applyReaction(
    evt: { message_id: string; channel_id: string; user_id: string; emoji: string },
    delta: 1 | -1
  ): void {
    this.ersetze(evt.channel_id, evt.message_id, (msg) => {
      // dispatchingUserId (not currentServerUserId): reaction_add/remove for a
      // DM arrive over the Cloud-background connection while a self-host may be
      // the active server — currentServerUserId() would return the self-host
      // pairwise id and never match the event's Cloud user_id, so the actor's
      // own reaction never flipped to "me". applyReaction runs synchronously in
      // the WS handler, so the dispatching connection is still in flight here.
      const isMe = evt.user_id === dispatchingUserId();
      const reactions = reaktionAnwenden(msg.reactions, evt.emoji, delta, isMe);
      return reactions && { ...msg, reactions };
    });
  }

  /** Setzt die Reaktions-Liste einer Nachricht hart — fuer Reaktions-
   *  Umschlaege verschluesselter Nachrichten (P1.5): dort gibt es kein
   *  `reaction_add`-Ereignis mit Delta, der Verlauf liefert den fertigen
   *  Stand (`verlaufReaktionAnwenden`). Nicht geladen = nichts zu tun. */
  setReactions(channelId: string, id: string, reactions: ReactionAggregate[]): void {
    this.ersetze(channelId, id, (alt) => ({ ...alt, reactions }));
  }

  /** E2EE-Bearbeitungs-Umschlag angewendet (P1.5 Teil 2): Text + edited_at
   *  auf der geladenen Nachricht ersetzen (harter Ersatz statt Delta). */
  bearbeiteInhalt(channelId: string, id: string, inhalt: string, bearbeitetAm: string): void {
    this.ersetze(channelId, id, (alt) => ({ ...alt, content: inhalt, edited_at: bearbeitetAm }));
  }

  /** Pin-Liste setzen (REST-Antwort beim Kanalöffnen). */
  setPins(channelId: string, pins: Message[]): void {
    this.pinsByChannel = { ...this.pinsByChannel, [channelId]: pins };
  }

  /**
   * WS `pin_update`: Pin-Liste fortschreiben und den `pinned_at`-Spiegel
   * auf der Nachricht selbst aktualisieren (falls sie geladen ist — der
   * Pin kann auch außerhalb des Historie-Fensters liegen).
   */
  applyPin(evt: { channel_id: string; message_id: string; pinned: boolean }): void {
    // Gespiegelte Nachricht VORHER holen — sie liefert ggf. den vollständigen
    // Pin-Listen-Eintrag (der WS-Event-Payload fehlen Inhalt/Autor).
    const geladen = this.byChannel[evt.channel_id]?.find((m) => m.id === evt.message_id);
    const pins = this.pinsByChannel[evt.channel_id];
    if (pins) {
      const next = pinsFortschreiben(pins, evt, geladen);
      if (next !== pins) this.pinsByChannel = { ...this.pinsByChannel, [evt.channel_id]: next };
    }
    this.ersetze(evt.channel_id, evt.message_id, (msg) => pinSpiegel(msg, evt.pinned));
  }

  /** Newest persisted (non-optimistic) message id in the channel, or null
   *  if empty / only optimistic placeholders. Used by the WS-reconnect
   *  gap-fill to request `?after=<lastId>`. Welche Ids als Cursor taugen und
   *  warum, steht bei `letzteServerId`. */
  lastPersistedId(channelId: string): string | null {
    const list = this.byChannel[channelId];
    return list ? letzteServerId(list) : null;
  }

  /** Merge a gap-fill page (messages strictly newer than `lastPersistedId`)
   *  into the channel non-destructively. Dedupes by id. A message that the
   *  WS already pushed during the round-trip is skipped by id. Eine Zeile mit
   *  der Nonce einer noch gehaltenen `tmp-`-Kopie ersetzt diese an Ort und
   *  Stelle (Begründung bei `lueckeZusammenfuehren`). */
  mergeGap(channelId: string, msgs: Message[]): void {
    if (!msgs.length) return;
    const list = this.byChannel[channelId] ?? [];
    const haveIds = this.messageIds[channelId] ?? new Set(list.map((m) => m.id));
    const merged = lueckeZusammenfuehren(list, haveIds, msgs, MessageStore.CAP);
    if (!merged) return;
    const { liste, verworfen, bestaetigteNonces } = merged;
    for (const nonce of bestaetigteNonces) this.confirmedNonces.add(nonce);
    this.vergiss(verworfen);
    this.byChannel = { ...this.byChannel, [channelId]: liste };
    // Rebuild the ID set after merge.
    this.messageIds = { ...this.messageIds, [channelId]: new Set(liste.map((m) => m.id)) };
    // Wurde gekappt, gehen die `krypto_id`s der weggefallenen Nachrichten mit —
    // sonst gälte eine davon, wieder hochgescrollt, als Dublette (Grabsteine bleiben).
    if (verworfen.length > 0) {
      const krypto = kryptoIdsVon(liste, this.grabsteine.fuer(channelId));
      this.kryptoIds = { ...this.kryptoIds, [channelId]: krypto };
    }
  }

  /** Re-sync already-present messages from a freshly re-fetched page —
   *  `content`, `edited_at` and `reactions`. Reaction toggles and edits that
   *  landed on *existing* messages while the WS was disconnected would
   *  otherwise stay stale until a full channel reload.
   *
   *  **The caller must pass a page that actually overlaps the ids we
   *  already hold.** A `?after=<lastId>` gap-fill page can't — by
   *  construction it contains only ids strictly newer than `lastId`, i.e.
   *  never anything already in `byChannel` — so passing it here is a
   *  silent no-op (see `gapFill.ts`, which fetches a separate cursor-less
   *  window for this). New messages in `msgs` are ignored here regardless
   *  — `mergeGap` owns those. */
  reconcile(channelId: string, msgs: Message[]): void {
    const list = this.byChannel[channelId];
    if (!list) return;
    const next = abgleichen(list, msgs);
    if (next !== list) this.byChannel = { ...this.byChannel, [channelId]: next };
  }

  /** Mark a channel as not loaded so the next visit re-fetches messages. */
  invalidateLoaded(channelId: string): void {
    delete this.loadedChannels[channelId];
  }

  /** Returns true if a message with the given nonce has been confirmed by the server (id not tmp-). */
  isConfirmed(nonce: string): boolean {
    return this.confirmedNonces.has(nonce);
  }

  clearChannel(channelId: string): void {
    this.lru.entfernen(channelId);
    const list = this.byChannel[channelId];
    this.byChannel = ohne(this.byChannel, channelId);
    this.loadedChannels = ohne(this.loadedChannels, channelId);
    this.messageIds = ohne(this.messageIds, channelId);
    this.kryptoIds = ohne(this.kryptoIds, channelId);
    this.grabsteine.vergessen(channelId);
    this.pinsByChannel = ohne(this.pinsByChannel, channelId);
    // Clear stale nonces from this channel.
    if (list) this.vergiss(list);
  }

  /** Full wipe — sign-out and server-switch only (`clearChannel` handles the
   *  per-channel WS-reconnect path). Drops the decoded attachment blobs with
   *  it: they belong to the account/server we are leaving. */
  clear(): void {
    this.byChannel = {};
    this.loadedChannels = {};
    this.messageIds = {};
    this.kryptoIds = {};
    this.grabsteine.leeren();
    this.pinsByChannel = {};
    this.confirmedNonces.clear();
    this.lru.leeren();
    clearBlobCache();
  }
}

export const messages = new MessageStore();
