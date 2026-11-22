/**
 * Twitch-Chat-Protokoll — reine, importfreie Parsing-Helfer für den nur-
 * lesenden Live-Chat in Watch-Partys. Bewusst ohne Runes/DOM-Imports, damit
 * alles unter `node --test` prüfbar bleibt (gleiche Philosophie wie
 * `stores/presenceAnzeige.ts`).
 *
 * Twitch liefert seinen Chat als IRC über WebSocket. Für Stufe 1 (anonym,
 * nur lesen) reicht:
 *   PASS SCHMOOPIIE / NICK justinfan<n> / CAP REQ :twitch.tv/tags
 *   nach 001: JOIN #<kanal>
 *   PRIVMSG-Zeilen mit Tags (display-name, color, emotes)
 *   PING :tmi.twitch.tv → PONG :tmi.twitch.tv
 * Bewusst NICHT behandelt (Stufe 1): USERNOTICE (Subs), CLEARCHAT/CLEARMSG
 * (Löschungen), Badges. Emote-Positionen im `emotes`-Tag sind Codepoint-
 * Indizes — bei Emoji-Texten zählt also nicht die UTF-16-Länge.
 */

export type TwitchChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'emote'; id: string; name: string };

export type TwitchChatMessage = {
  /** IRC-`id`-Tag (eindeutig je Nachricht) — dient als Render-Key. */
  id: string;
  /** Login-Name (aus dem IRC-Präfix). */
  login: string;
  displayName: string;
  /** IRC-`color`-Tag (#rrggbb) oder null, wenn Twitch keine vergeben hat. */
  color: string | null;
  /** `/me`-Nachricht → kursiv und ohne Doppelpunkt darstellen. */
  action: boolean;
  parts: TwitchChatPart[];
};

export type IrcLine = {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
};

const TAG_ESCAPES: Record<string, string> = {
  s: ' ',
  ':': ';',
  '\\': '\\',
  r: '\r',
  n: '\n'
};

/** IRCv3-Tag-Werte entschärfen (``\s`` → Leerzeichen usw.). */
export function unescapeTag(v: string): string {
  return v.replace(/\\(.)/g, (_m, ch: string) => TAG_ESCAPES[ch] ?? ch);
}

/** Eine IRC-Zeile in Tags/Präfix/Befehl/Parameter zerlegen. `trailing`
 *  (letzter Parameter nach `` :``) landet unescaped als letzter Eintrag in
 *  `params`. Ungültige Zeilen → null. */
export function parseIrcLine(line: string): IrcLine | null {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    for (const pair of rest.slice(1, sp).split(';')) {
      const eq = pair.indexOf('=');
      if (eq < 0) tags[pair] = '';
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  // trailing-Parameter: erster `` :`` trennt den freien Text (Leerzeichen!).
  let params: string[];
  const sep = rest.indexOf(' :');
  if (sep >= 0) {
    const trailing = rest.slice(sep + 2);
    const front = rest.slice(0, sep).split(' ').filter((p) => p.length > 0);
    params = [...front, trailing];
  } else {
    params = rest.split(' ').filter((p) => p.length > 0);
  }
  const command = params.shift();
  if (!command) return null;
  return { tags, prefix, command: command.toUpperCase(), params };
}

function loginFromPrefix(prefix: string): string {
  return prefix.split('!')[0] ?? '';
}

type EmoteRange = { id: string; start: number; end: number };

/** `emotes`-Tag (``25:0-4,6-10/1902:12-16``) in sortierte, überlappfreie
 *  Codepoint-Bereiche zerlegen. Fehlt/leer → []. */
function parseEmoteRanges(tag: string | undefined): EmoteRange[] {
  if (!tag) return [];
  const ranges: EmoteRange[] = [];
  for (const group of tag.split('/')) {
    const [id, positions] = group.split(':');
    if (!id || !/^\d+$/.test(id) || !positions) continue;
    for (const pos of positions.split(',')) {
      const [a, b] = pos.split('-');
      const start = Number(a);
      const end = Number(b);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < 0) continue;
      ranges.push({ id, start, end });
    }
  }
  ranges.sort((x, y) => x.start - y.start);
  // Überlappende Bereiche (kaputtes Tag) verwerfen statt doppelt splitten.
  const clean: EmoteRange[] = [];
  for (const r of ranges) {
    const last = clean[clean.length - 1];
    if (last && r.start <= last.end) continue;
    clean.push(r);
  }
  return clean;
}

/** Nachrichtentext in Text- und Emote-Bauteile zerlegen. `cps` sind die
 *  Codepoints des Texts (``Array.from``). */
function buildParts(cps: string[], ranges: EmoteRange[]): TwitchChatPart[] {
  const parts: TwitchChatPart[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos || r.end >= cps.length) continue;
    if (r.start > pos) parts.push({ kind: 'text', text: cps.slice(pos, r.start).join('') });
    parts.push({ kind: 'emote', id: r.id, name: cps.slice(r.start, r.end + 1).join('') });
    pos = r.end + 1;
  }
  if (pos < cps.length) parts.push({ kind: 'text', text: cps.slice(pos).join('') });
  return parts;
}

let syntheticId = 0;

/** Eine Chat-Zeile in eine Nachricht übersetzen. Alles, was kein PRIVMSG
 *  ist (PING, JOIN, NOTICE, …), ergibt null — die Verbindungsschicht
 *  entscheidet selbst über solche Befehle. */
export function parseChatMessage(line: string): TwitchChatMessage | null {
  const parsed = parseIrcLine(line);
  if (!parsed || parsed.command !== 'PRIVMSG' || parsed.params.length < 2) return null;
  let text = parsed.params[1];
  let action = false;
  // /me-Aktionen reisen als CTCP-gerahmter Text: 0x01 + "ACTION " … 0x01.
  // Das Rahmenzeichen per fromCharCode — rohe Steuerzeichen im Quelltext
  // sind unsichtbar-fragil.
  const ctcp = String.fromCharCode(1);
  if (text.startsWith(ctcp + 'ACTION ') && text.endsWith(ctcp)) {
    action = true;
    text = text.slice(8, -1);
  }
  const login = loginFromPrefix(parsed.prefix) || parsed.tags['login'] || 'jemand';
  const displayName = parsed.tags['display-name'] || login;
  const color = parsed.tags['color'] || null;
  const cps = Array.from(text);
  const parts = buildParts(cps, parseEmoteRanges(parsed.tags['emotes']));
  return {
    id: parsed.tags['id'] || `synthetic-${++syntheticId}`,
    login,
    displayName,
    color,
    action,
    parts
  };
}

/** Fallback-Farbe für Chatter ohne color-Tag: kleiner Hash über den Login
 *  wählt aus einer auf dunklem Grund lesbaren Palette. */
const ERSATZ_PALETTE = [
  '#FF7A7A',
  '#4ECDC4',
  '#FFD93D',
  '#6BCB77',
  '#A78BFA',
  '#FF9F45',
  '#45B7D1',
  '#F472B6'
];

export function ersatzFarbe(login: string): string {
  // FNV-1a — deterministisch, Verteilung reicht locker für 8 Farben.
  let h = 0x811c9dc5;
  for (let i = 0; i < login.length; i++) {
    h ^= login.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ERSATZ_PALETTE[h % ERSATZ_PALETTE.length];
}

/** Sehr dunkle Twitch-Farben (z. B. #000000) auf dunklem Panel anheben —
 *  sonst verschwinden Namen. Helligkeitsschwelle bewusst grob. */
export function lesbareFarbe(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = m[1];
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (l >= 0.2) return hex;
  const heben = (c: number): number => Math.round(c + (255 - c) * 0.45);
  const toHex = (c: number): string => c.toString(16).padStart(2, '0');
  return `#${toHex(heben(r))}${toHex(heben(g))}${toHex(heben(b))}`;
}

/** Anzeigefarbe einer Nachricht: Twitch-Farbe (ggf. aufgehellt) oder
 *  Ersatzfarbe aus dem Login. */
export function anzeigeFarbe(color: string | null, login: string): string {
  return color ? lesbareFarbe(color) : ersatzFarbe(login);
}
