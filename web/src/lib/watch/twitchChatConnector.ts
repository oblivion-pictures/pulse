/**
 * TwitchChatConnector — eine anonyme, nur-lesende IRC-WebSocket pro Twitch-
 * Kanal für den Live-Chat in Watch-Partys. Reines TS ohne Runes und ohne
 * Import-Zeit-DOM-Zugriff (die Socket-Fabrik ist injizierbar), damit der
 * ganze Automat unter `node --test` prüfbar ist. Die reaktive Hülle ist
 * `stores/twitchChat.svelte.ts`.
 *
 * Verbindungsweg: wss://irc-ws.chat.twitch.tv — PASS SCHMOOPIIE /
 * NICK justinfan<n> / CAP REQ :twitch.tv/tags, nach 001 JOIN #<kanal>.
 * Anonyme justinfan-Verbindungen dürfen nur lesen — genau unser Fall.
 *
 * Lastschutz: Nachrichten werden gebündelt (Standard 200 ms) und in einem
 * Ring aus MAX_BUFFER Einträgen gehalten; Großkanäle mit Hunderten
 * Nachrichten pro Sekunde dürfen die UI so nicht in Einzelrenders ertränken.
 */

// .ts-Endung bewusst: Nodes Unit-Testläufer (kein Bundler) braucht sie, um
// den Nachbar aufzulösen — Projekt-Muster siehe utils/snowflake.ts.
import { parseChatMessage, parseIrcLine, type TwitchChatMessage } from './twitchIrc.ts';

export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

export type TwitchChatStatus = 'connecting' | 'connected' | 'reconnecting';

/** Struktureller Ausschnitt von WebSocket — im Test durch einen Fake ersetzt. */
export interface TwitchSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface TwitchChatConnectorOptions {
  socketFactory?: (url: string) => TwitchSocketLike;
  flushMs?: number;
  retryDelaysMs?: number[];
}

export const MAX_BUFFER = 150;

const DEFAULT_FLUSH_MS = 200;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export class TwitchChatConnector {
  /** Kanalname kleingeschrieben (IRC-Form von Twitch). */
  readonly channel: string;

  /** Neue Nachrichten (seit dem letzten Flush) — Nachschub für die Anzeige. */
  onMessages: ((batch: TwitchChatMessage[]) => void) | null = null;
  onStatus: ((status: TwitchChatStatus) => void) | null = null;

  private readonly socketFactory: (url: string) => TwitchSocketLike;
  private readonly flushMs: number;
  private readonly retryDelaysMs: number[];
  private socket: TwitchSocketLike | null = null;
  private started = false;
  private disposed = false;
  private retryIdx = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: TwitchChatMessage[] = [];
  private readonly buffer: TwitchChatMessage[] = [];

  constructor(channel: string, opts: TwitchChatConnectorOptions = {}) {
    this.channel = channel.toLowerCase();
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** Verbindung aufbauen (idempotent). Aufrufer: der Store, per acquire(). */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.connect();
  }

  /** Verbindung abbauen und den Wiederverbindungs-Automat stoppen. */
  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    const sock = this.socket;
    this.socket = null;
    // onclose vorher abklemmen: unser eigenes close() ist kein Grund zum
    // Wiederverbinden. Ein echtes WebSocket feuert onclose async — der
    // disposed-Wächter fängt auch das ab.
    if (sock) {
      sock.onclose = null;
      try {
        sock.close();
      } catch {
        /* schon zu */
      }
    }
  }

  /** Aktueller Ring (älteste zuerst) — Read-only-Blick für Tests/Anzeige. */
  get messages(): readonly TwitchChatMessage[] {
    return this.buffer;
  }

  private connect(): void {
    if (this.disposed) return;
    this.emitStatus('connecting');
    try {
      this.socket = this.socketFactory(TWITCH_IRC_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    const sock = this.socket;
    sock.onopen = () => {
      // Anonymer nur-Lese-Login (offizieller Weg ohne Konto) + Tags-Capability
      // für display-name/color/emotes.
      const nick = `justinfan${10000 + Math.floor(Math.random() * 89999)}`;
      sock.send('PASS SCHMOOPIIE');
      sock.send(`NICK ${nick}`);
      sock.send('CAP REQ :twitch.tv/tags');
    };
    sock.onmessage = (ev) => this.handleData(ev.data);
    sock.onclose = () => this.handleClose();
    sock.onerror = () => {
      /* onclose folgt immer — dort greift der Automat */
    };
  }

  private handleData(data: string): void {
    for (const raw of data.split('\r\n')) {
      if (!raw) continue;
      this.handleLine(raw);
    }
  }

  private handleLine(line: string): void {
    const parsed = parseIrcLine(line);
    if (!parsed) return;
    switch (parsed.command) {
      case 'PING': {
        // Gleichen Parameter zurückschicken; der Parser hat den Doppelpunkt
        // des trailing-Parameters abgetrennt — hier wieder aufsetzen.
        const param = (parsed.params[0] ?? 'tmi.twitch.tv').replace(/^:/, '');
        this.socket?.send(`PONG :${param}`);
        return;
      }
      case '001':
        this.socket?.send(`JOIN #${this.channel}`);
        return;
      case 'JOIN':
        // Bestätigung des eigenen JOIN → Kanal-Chat läuft.
        this.retryIdx = 0;
        this.emitStatus('connected');
        return;
      case 'RECONNECT':
        // Twitch schickt das selten; Verwerfen + sauber neu verbinden.
        this.socket?.close();
        return;
      case 'PRIVMSG': {
        const msg = parseChatMessage(line);
        if (!msg) return;
        this.pending.push(msg);
        if (this.flushTimer === null) {
          this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
        }
        return;
      }
      default:
        return;
    }
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.buffer.push(...batch);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
    this.onMessages?.(batch);
  }

  private handleClose(): void {
    if (this.disposed) return;
    this.socket = null;
    this.emitStatus('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer !== null) return;
    const delay = this.retryDelaysMs[Math.min(this.retryIdx, this.retryDelaysMs.length - 1)];
    this.retryIdx++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private emitStatus(status: TwitchChatStatus): void {
    this.onStatus?.(status);
  }
}

function defaultSocketFactory(url: string): TwitchSocketLike {
  return new WebSocket(url) as unknown as TwitchSocketLike;
}
