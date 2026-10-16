/**
 * Sound playback engine. HTMLAudioElement-pooled to allow rapid retriggers
 * without re-loading the asset. Tolerant of missing files — a genuinely
 * unplayable asset (decoder failure / 404 → MEDIA_ERR_SRC_NOT_SUPPORTED)
 * marks the URL as "missing" and silences further plays for it (no
 * console-spam, no exception). Transient errors (network abort, a play
 * interrupted by a quick leave) do NOT blacklist — they only discard the one
 * bad pooled element so the next play rebuilds a fresh one. Autoplay policy:
 * the very first play before user-gesture may be blocked by Chromium; we
 * catch and swallow.
 *
 * Volume = settings.sounds.masterVolume * category.volume (gated by
 * masterEnabled + category.enabled). `test(id)` bypasses the toggle gating
 * so users can audition a sound even if its category is disabled.
 *
 * Per-guild overrides: callers pass ``{ guildId }`` when the trigger has a
 * guild context (voice, notifications, message-send). The resolver checks
 * ``guildSounds.urlFor`` first, falls back to the bundled ``/sounds/<file>.ogg``
 * otherwise. Pools + missing-set are keyed by URL so guilds with custom
 * sounds don't fight over a SoundId slot.
 *
 * **iOS-WebKit spielt ohne Media-Element** (`tonWeg.ts`, `webAudioTon.ts`):
 * dort läuft jeder Ton über Web Audio, damit WebKit keine „Jetzt läuft"-
 * Anzeige anlegt und der Hülle nicht die Audio-Session nimmt. Debounce, Gain
 * und die Auflösung der Gilden-Töne bleiben hier, für beide Wege gleich.
 */

import { settings } from '$lib/stores/settings.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { isIosWebKit } from '$lib/platform/runtime';
import { iosTonGespielt } from '$lib/diagnose/iosTonDiagnose';
import { SOUNDS, type SoundId, type SoundCategory } from './registry';
import { tonEndungen, tonWeg, type TonWeg } from './tonWeg';
import { WebAudioTon } from './webAudioTon';

const SOUND_DIR = '/sounds';
/** Browsers decode .ogg/.mp3 transparently — we try each in order at
 *  first play and cache whichever loads. Order matters: prefer OGG
 *  Vorbis (smaller, matches the existing 13 bundled assets) and fall
 *  back to .mp3 if the .ogg slot is empty. Per-guild user uploads
 *  bypass this chain — the override URL is whatever the browser
 *  fetched, and the per-guild MinIO upload pins content-type.
 *  Die Kette hängt am Weg (`tonWeg.ts::tonEndungen`): iOS nimmt `.m4a` zuerst. */
const DEBOUNCE_MS = 50;
/** Gesten, die nach WebKits Regel als Nutzeraktivierung zählen: ein Tipp
 *  aktiviert erst beim Loslassen (`touchend`/`click`), `pointerdown` nur mit
 *  der Maus (Gegenprüfung T5). */
const GESTEN = ['touchend', 'click', 'keydown'] as const;
const MAX_CONCURRENT_PER_URL = 3;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function categoryGain(category: SoundCategory): number {
  const s = settings.sounds;
  if (!s.masterEnabled) return 0;
  const cat = s[category];
  if (!cat.enabled) return 0;
  return clamp01(s.masterVolume) * clamp01(cat.volume);
}

function bypassGain(category: SoundCategory): number {
  const s = settings.sounds;
  return clamp01(s.masterVolume) * clamp01(s[category].volume);
}

function defaultUrls(id: SoundId): string[] {
  return tonEndungen(aktuellerWeg()).map((ext) => `${SOUND_DIR}/${SOUNDS[id].file}.${ext}`);
}

/** Der Weg dieser Umgebung (`tonWeg.ts`). Je Aufruf gefragt statt einmal beim
 *  Import: im Node-Test und beim Vorrendern gibt es weder `navigator` noch
 *  `AudioContext`, und die Antwort darf dort nicht festfrieren. */
function aktuellerWeg(): TonWeg {
  return tonWeg({
    iosWebKit: isIosWebKit(),
    audioContextDa: typeof AudioContext !== 'undefined'
  });
}

type PlayOpts = {
  /** Guild whose overrides should be consulted. Omit for guild-less
   * events (DM notifications, generic UI). */
  guildId?: string | null;
};

class SoundEngine {
  /** Nur auf iOS-WebKit benutzt — angelegt beim ersten Ton dort. */
  #webAudio: WebAudioTon | null = null;
  /** Läuft vor jedem Ton auf dem iOS-Weg. Die Hülle hängt hier WebKits
   *  `ambient`-Erklärung ein (`platform/iosSprache.ts`), solange ein nativer
   *  Raum steht — sonst bleibt es leer. */
  vorWebAudioTon: (() => void) | null = null;
  #pool = new Map<string, HTMLAudioElement[]>();
  #lastPlay = new Map<string, number>();
  #missing = new Set<string>();
  /** Zuletzt aufgelöste Override-URLs → ihre Guild. Braucht die
   *  Selbstheilung: schlägt ein Override-Play fehl (abgelaufene Presign-
   *  Signatur), refresh't der Store statt zu blacklisten — Bundled-URLs
   *  haben ihren Kette-Fallback, Overrides sonst keinen Ausweg. */
  #overrideGuild = new Map<string, string>();

  constructor() {
    // iOS: eine Geste gibt den Kontext frei (iOS-Safari verlangt das; die
    // Hülle erlaubt Wiedergabe ohne Geste, dort schadet es nicht). WebKit hebt
    // die Sperre nach dem ersten GELUNGENEN Start auf — abgemeldet wird also
    // erst danach, nicht schon nach dem ersten Versuch.
    if (typeof document === 'undefined' || aktuellerWeg() !== 'webaudio') return;
    const geste = () => {
      void this.entsperren().then((frei) => {
        if (!frei) return;
        for (const art of GESTEN) document.removeEventListener(art, geste, true);
      });
    };
    for (const art of GESTEN) document.addEventListener(art, geste, true);
  }

  /** Play if the relevant category-toggle is on. Silent no-op otherwise. */
  play(id: SoundId, opts: PlayOpts = {}): void {
    this.#spiele(id, categoryGain(SOUNDS[id].category), opts);
  }

  /** Force-play for settings UI test buttons — respects master + category
   *  volume but ignores per-category `enabled` so users can audition. */
  test(id: SoundId, opts: PlayOpts = {}): void {
    this.#spiele(id, bypassGain(SOUNDS[id].category), opts);
  }

  /** Geteilter Weg von `play`/`test`: Gain berechnet der Aufrufer (mit oder
   *  ohne Kategorien-Schalter), hier folgen nur noch die No-op-Gates. */
  #spiele(id: SoundId, gain: number, opts: PlayOpts): void {
    const weg = aktuellerWeg();
    if (weg === 'still') return;
    if (weg === 'element' && typeof Audio === 'undefined') return;
    if (gain <= 0) return;
    const url = this.#resolve(id, opts.guildId);
    if (url === null) return;
    // iOS: jeder Ton mit WebKits Session-Stand in den Diagnose-Ring — der Ton
    // war der Auslöser in Kette K1 (`diagnose/iosTonDiagnose.ts`).
    if (weg === 'webaudio') {
      this.vorWebAudioTon?.();
      iosTonGespielt(id);
    }
    this.#emit(id, url, gain, weg);
  }

  /** Returns true if the *default* asset for ``id`` is missing. The
   *  per-user Settings → Sounds panel uses this to grey-out the test
   *  button when the bundled file is absent. We treat a sound as
   *  missing only when *every* candidate extension in the chain has
   *  failed to load — that way the test button stays interactive as
   *  long as the user could still drop a .mp3 in to fill the gap. */
  isMissing(id: SoundId): boolean {
    return defaultUrls(id).every((url) => this.#missing.has(url));
  }

  /** Drop a single URL from the pool + missing-set. Called when the
   * backend tells us a guild's override changed — the cached
   * HTMLAudioElement still points at the old (expired) presigned URL
   * and a re-play would silently fail. */
  invalidateUrl(url: string): void {
    this.#webAudio?.vergessen(url);
    this.#pool.delete(url);
    this.#missing.delete(url);
    this.#lastPlay.delete(url);
    this.#overrideGuild.delete(url);
  }

  #resolve(id: SoundId, guildId: string | null | undefined): string | null {
    const override = guildSounds.urlFor(id, guildId);
    if (override) {
      if (guildId) this.#overrideGuild.set(override, guildId);
      return override;
    }
    for (const url of defaultUrls(id)) {
      if (!this.#missing.has(url)) return url;
    }
    return null;
  }

  /** Pick the next URL in the default-extension chain after ``current``.
   *  Returns null if ``current`` is the last candidate, or if it's not
   *  part of the chain (e.g. a per-guild override URL — those are
   *  single-shot, no fallback). */
  #nextDefaultUrl(id: SoundId, current: string): string | null {
    const urls = defaultUrls(id);
    const idx = urls.indexOf(current);
    if (idx < 0 || idx >= urls.length - 1) return null;
    return urls[idx + 1];
  }

  #emit(id: SoundId, url: string, gain: number, weg: TonWeg): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = this.#lastPlay.get(url) ?? 0;
    if (now - last < DEBOUNCE_MS) return;
    this.#lastPlay.set(url, now);
    if (weg === 'webaudio') void this.#starteWebAudio(id, url, gain, true);
    else this.#start(id, url, gain, true);
  }

  /** Aus einer Nutzergeste (iOS): den Kontext freigeben, damit der erste Ton
   *  danach nicht an WebKits Wiedergabe-Regel scheitert. */
  entsperren(): Promise<boolean> {
    if (aktuellerWeg() !== 'webaudio') return Promise.resolve(false);
    return this.#webAudioHolen().entsperren();
  }

  #webAudioHolen(): WebAudioTon {
    this.#webAudio ??= new WebAudioTon({
      neuerKontext: () => new AudioContext(),
      // Gilden-Töne sind vorsignierte S3-URLs auf einem anderen Pfad, oft einem
      // anderen Host: der Objektspeicher-Zweig im Proxy setzt dafür CORS `*`
      // (`infra/prod/web-nginx.conf`, `Caddyfile.template`). Ohne Anmeldedaten —
      // die Signatur ist die Berechtigung.
      holen: (u) => fetch(u, { credentials: 'omit' })
    });
    return this.#webAudio;
  }

  /**
   * Der iOS-Weg (`tonWeg.ts`). Dieselben Regeln wie `#start`, ohne Element:
   * eine fehlende oder undekodierbare gebündelte Datei rückt in der Kette
   * weiter, ein gescheiterter Gilden-Ton holt frische Signaturen und spielt
   * DIESES Mal den gebündelten. Kein Rückfall aufs Element, nirgends.
   * `darfAusweichen` begrenzt das Ausweichen eines Gilden-Tons auf einmal.
   */
  async #starteWebAudio(id: SoundId, url: string, gain: number, darfAusweichen: boolean) {
    const ergebnis = await this.#webAudioHolen().spielen(url, gain);
    if (ergebnis === 'gespielt' || ergebnis === 'still') return;
    const gid = this.#overrideGuild.get(url);
    if (gid !== undefined) {
      if (!darfAusweichen) return;
      // Abgelaufene Signatur: frisch holen. Ein Format, das iOS nicht
      // dekodiert (Ogg-Upload), heilt eine neue Signatur nicht — dann nur
      // ausweichen. In beiden Fällen klingt JETZT der gebündelte Ton.
      if (ergebnis !== 'dekodierfehler') void guildSounds.refresh(gid);
      const fallback = defaultUrls(id).find((u) => !this.#missing.has(u));
      if (fallback) await this.#starteWebAudio(id, fallback, gain, false);
      return;
    }
    // Gebündelte Datei: ein Netzfehler ist vorübergehend und rückt nicht
    // weiter; fehlt sie oder dekodiert sie nicht, kommt die nächste Endung.
    if (ergebnis === 'ladefehler') return;
    this.#missing.add(url);
    const next = this.#nextDefaultUrl(id, url);
    if (next) await this.#starteWebAudio(id, next, gain, false);
  }

  /**
   * Acquire a pooled element and play it. A pooled element can be left in a
   * state where `play()` rejects: a prior play was *interrupted* (you left the
   * channel while the join chime was still loading/playing → AbortError), the
   * element was paused mid-load, or a transient seek/decode race hit. When that
   * happens we discard the bad element and retry ONCE with a freshly-built one
   * — without that retry the same broken element keeps getting reused and the
   * sound silently goes missing on a re-join. We do NOT retry NotAllowedError
   * (autoplay block): a fresh element won't help until the next user gesture.
   *
   * For *default* URLs the source-load failure (404 / unsupported
   * format) is caught via the `error` event and triggers a chain
   * fallback to the next extension in the chain (e.g. .ogg missing →
   * try .mp3). Override URLs skip the chain since the user uploaded
   * whatever the browser fetched.
   */
  #start(id: SoundId, url: string, gain: number, allowRetry: boolean): void {
    const audio = this.#acquire(url);
    if (!audio) return;
    audio.volume = clamp01(gain);
    try {
      audio.currentTime = 0;
    } catch {
      /* some browsers throw if metadata hasn't loaded — ignore */
    }
    let handled = false;
    const onLoadFail = () => {
      if (handled) return;
      handled = true;
      this.#discard(url, audio);
      const gid = this.#overrideGuild.get(url);
      if (gid !== undefined) {
        // Override-URL (presigned, kurzlebig): kein Blacklisting — die
        // Signatur ist wahrscheinlich abgelaufen. Store frisch holen,
        // der nächste Play bekommt eine neue Signatur und klappt.
        void guildSounds.refresh(gid);
        // Aber DIESER Play bleibt nicht stumm: auf das gebündelte Default
        // ausweichen — derselbe Degradationsgrad wie der Alters-Guard in
        // guildSounds.urlFor (schweigt erst am Signaturende, siehe
        // sounds/frische.ts). Vorher starb der Cue lautlos, wenn eine
        // Signatur trotz Guard alt war (z. B. replayReadyForActivation
        // seedet alte URLs mit frischem
        // fetchedAt — Security-/Bug-Nachfrage 2026-09-18, Stream-Start-
        // Sound nach Serverwechsel).
        const fallback = defaultUrls(id).find((u) => !this.#missing.has(u));
        if (fallback) this.#start(id, fallback, gain, false);
        return;
      }
      this.#missing.add(url);
      const next = this.#nextDefaultUrl(id, url);
      if (next) this.#start(id, next, gain, false);
    };
    const onPlayFail = () => {
      if (handled) return;
      handled = true;
      if (!allowRetry) return;
      this.#discard(url, audio);
      this.#start(id, url, gain, false);
    };
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError') return;
        // Same guard as the error-event listener below — a transient
        // decode/seek glitch on an element that HAD buffered playable
        // data (the "PTS is not defined" Chromium FFmpeg demuxer quirk
        // called out in `#acquire`) must NOT trigger the chain fallback,
        // it just needs a fresh element for the same URL.
        if (audio.error?.code === 4 && audio.readyState < 2) onLoadFail();
        else onPlayFail();
      });
    }
    audio.addEventListener(
      'error',
      () => {
        if (audio.error?.code === 4 && audio.readyState < 2) onLoadFail();
      },
      { once: true }
    );
  }

  /** Drop a single element from its pool so the next acquire rebuilds a fresh
   *  one. Pauses it first to release the decoder. If the pool is now
   *  empty, remove the URL entry from the pool map — otherwise a chain
   *  of failed `.ogg` then `.mp3` would leave an ever-growing set of
   *  empty per-URL arrays behind. */
  #discard(url: string, audio: HTMLAudioElement): void {
    const pool = this.#pool.get(url);
    if (pool) {
      const i = pool.indexOf(audio);
      if (i >= 0) pool.splice(i, 1);
      if (pool.length === 0) this.#pool.delete(url);
    }
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
  }

  #acquire(url: string): HTMLAudioElement | null {
    let pool = this.#pool.get(url);
    if (!pool) {
      pool = [];
      this.#pool.set(url, pool);
    }
    for (const a of pool) {
      if (a.paused || a.ended) return a;
    }
    if (pool.length >= MAX_CONCURRENT_PER_URL) {
      const a = pool[0];
      try {
        a.pause();
      } catch {
        /* ignore */
      }
      return a;
    }
    const a = new Audio(url);
    a.preload = 'auto';
    a.addEventListener(
      'error',
      () => {
        // Only a *genuine* load failure — the resource never produced any
        // decodable data (404, wrong container/codec) — should blacklist the URL
        // so we stop retrying. Detect that by readyState < HAVE_CURRENT_DATA: the
        // element never reached playable data.
        //
        // An element that HAD buffered playable data and then errors is NOT
        // missing — it's a transient decode/seek glitch. Some Ogg/Vorbis files
        // make Chromium's FFmpeg demuxer throw MEDIA_ERR_SRC_NOT_SUPPORTED (4)
        // with "DEMUXER_ERROR_COULD_NOT_PARSE: PTS is not defined" when a *pooled*
        // element is re-seeked (`currentTime = 0`) for replay — even though the
        // file plays fine on a fresh element. Blacklisting on that permanently
        // silences a working sound for the whole session (join chime vanishes
        // after the first leave+rejoin). So we only discard the poisoned element;
        // the next play rebuilds a fresh one, which re-decodes cleanly.
        const neverLoaded = a.readyState < 2; // < HAVE_CURRENT_DATA
        if (a.error?.code === 4 && neverLoaded) {
          // Das tote Element in JEDEM Fall entsorgen — sonst bleibt es in
          // liegen im Pool und jeder Play versucht dieselbe kaputte Quelle
          // erneut (Overrides: abgelaufene Presign-Signatur).
          this.#discard(url, a);
          // Override-URLs nicht blacklist(en) — die sind nur kurzlebig
          // signiert, der Store-Refresh heilt sie (siehe onLoadFail).
          if (!this.#overrideGuild.has(url)) this.#missing.add(url);
        } else {
          this.#discard(url, a);
        }
      },
      { once: true }
    );
    pool.push(a);
    return a;
  }
}

export const sounds = new SoundEngine();
