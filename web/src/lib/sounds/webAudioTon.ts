/**
 * Hinweistöne über Web Audio statt über ein Media-Element — der iOS-Weg der
 * Ton-Engine (`engine.ts`, Weiche in `tonWeg.ts`, dort steht das Warum).
 *
 * Ein geteilter `AudioContext`, je URL einmal geholt und dekodiert, je Ton eine
 * `AudioBufferSourceNode → GainNode → destination`. Keine Wiedergabe hinterlässt
 * etwas, das WebKit als „Jetzt läuft" anmelden könnte.
 *
 * **Der Kontext schläft, solange nichts klingt.** Ein laufender `AudioContext`
 * rechnet auch Stille durch und hält WebKits Audio-Ausgabe wach — für ein paar
 * Töne am Tag wäre das ein Dauerverbraucher. Nach `ruheMs` ohne Ton wird er
 * angehalten (`suspend`) und vor dem nächsten geweckt. Scheitert das Wecken
 * (iOS-Safari vor der ersten Geste, WebKits `interrupted`), bleibt der Ton aus:
 * ein verspätet nachgereichter Hinweis ist schlimmer als keiner, und ein
 * Rückfall aufs Element ist ausgeschlossen (`tonWeg.ts`).
 *
 * **Fehler werden unterschieden, weil die Engine verschieden reagiert:**
 * `fehlt` (HTTP 404/410) und `dekodierfehler` sind endgültig für DIESE URL,
 * `ladefehler` (Netz, abgelaufene Signatur) nicht — nur Dekodierfehler werden
 * zwischengespeichert, damit ein undekodierbarer Gilden-Ton nicht bei jedem
 * Ton neu geholt wird.
 *
 * **Der Zwischenspeicher hängt am Pfad, nicht an der vollen URL, und ist
 * begrenzt** (Gegenprüfung T3): Gilden-Töne kommen als vorsignierte URLs, die
 * alle paar Minuten eine neue Signatur tragen. Je Signatur ein Eintrag mit
 * dekodiertem PCM (bis ~1 MB je Ton) wuchs über Stunden in Dutzende MB — und
 * ein Neustart des WebContent-Prozesses ist selbst ein Verdacht in K1. Die
 * Signatur ist nur die Berechtigung, der Inhalt hängt am Pfad; ersetzt eine
 * Gilde ihren Ton unter demselben Pfad, vergisst die Engine ihn
 * (`invalidateUrl`, angestossen von `guildSounds`).
 *
 * Importfrei, Kontext und `fetch` werden hineingereicht — damit Nodes Läufer
 * den Weg prüfen kann (CLAUDE.md, `pnpm test:unit`).
 */

export interface PufferArtig {
  readonly duration: number;
}

interface KnotenArtig {
  connect(ziel: unknown): unknown;
  disconnect(): void;
}

export interface QuelleArtig extends KnotenArtig {
  buffer: PufferArtig | null;
  onended: ((ev: Event) => unknown) | null;
  start(): void;
  stop(): void;
}

export interface GainArtig extends KnotenArtig {
  gain: { value: number };
}

export interface KontextArtig {
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  decodeAudioData(daten: ArrayBuffer): Promise<PufferArtig>;
  createBufferSource(): QuelleArtig;
  createGain(): GainArtig;
}

export interface AntwortArtig {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type TonErgebnis = 'gespielt' | 'fehlt' | 'ladefehler' | 'dekodierfehler' | 'still';

export interface WebAudioUmgebung {
  /** Legt den Kontext an — erst beim ersten Ton oder der ersten Geste. `null`,
   *  wenn es keinen gibt. */
  neuerKontext: () => KontextArtig | null;
  holen: (url: string) => Promise<AntwortArtig>;
  /** Wie lange der Kontext nach dem letzten Ton noch läuft. */
  ruheMs?: number;
  /** Wie lange auf das Wecken gewartet wird, bevor der Ton ausfällt. */
  weckFristMs?: number;
}

/** Wie in der Engine: mehr gleichzeitige Wiedergaben derselben Datei kappen
 *  die ältesten. */
const HOECHSTENS_JE_URL = 3;
/** Höchstens so viele dekodierte Töne im Speicher (16 gebündelte + Gilden). */
export const PUFFER_GRENZE = 24;

/** Schlüssel ohne Query und Fragment — die Signatur gehört nicht dazu. */
export function tonSchluessel(url: string): string {
  const ende = url.search(/[?#]/);
  return ende < 0 ? url : url.slice(0, ende);
}

class Dekodierfehler extends Error {}
class FehltFehler extends Error {}

export class WebAudioTon {
  readonly #u: Required<WebAudioUmgebung>;
  #kontext: KontextArtig | null = null;
  readonly #puffer = new Map<string, Promise<PufferArtig>>();
  readonly #laufend = new Map<string, QuelleArtig[]>();
  #aktiv = 0;
  #ruheUhr: ReturnType<typeof setTimeout> | undefined;

  constructor(u: WebAudioUmgebung) {
    this.#u = { ruheMs: 3000, weckFristMs: 1500, ...u };
  }

  /** Spielt `url` mit `gain` (0..1). Wirft nie. */
  async spielen(url: string, gain: number): Promise<TonErgebnis> {
    const ctx = this.#kontextHolen();
    if (!ctx) return 'still';
    let puffer: PufferArtig;
    try {
      puffer = await this.#dekodiert(ctx, url);
    } catch (e) {
      if (e instanceof Dekodierfehler) return 'dekodierfehler';
      return e instanceof FehltFehler ? 'fehlt' : 'ladefehler';
    }
    if (!(await this.#wecken(ctx))) return 'still';
    this.#abspielen(ctx, url, puffer, gain);
    return 'gespielt';
  }

  /** Aus einer Nutzergeste: den Kontext anlegen und einmal wecken, damit
   *  iOS-Safari ihn für spätere Töne ohne Geste freigibt. Danach schläft er
   *  wieder ein, wenn nichts klingt. */
  async entsperren(): Promise<boolean> {
    const ctx = this.#kontextHolen();
    if (!ctx) return false;
    if (ctx.state === 'running') return true;
    try {
      await ctx.resume();
    } catch {
      return false;
    }
    this.#ruheNachHinten();
    return ctx.state === 'running';
  }

  /** Eine URL vergessen (Gilden-Ton geändert, Signatur abgelaufen). */
  vergessen(url: string): void {
    this.#puffer.delete(tonSchluessel(url));
  }

  #kontextHolen(): KontextArtig | null {
    if (!this.#kontext) {
      try {
        this.#kontext = this.#u.neuerKontext();
      } catch {
        this.#kontext = null;
      }
    }
    return this.#kontext;
  }

  #dekodiert(ctx: KontextArtig, url: string): Promise<PufferArtig> {
    const schluessel = tonSchluessel(url);
    const vorhanden = this.#puffer.get(schluessel);
    if (vorhanden) {
      // Zuletzt benutzt nach hinten — die Grenze räumt vorn ab.
      this.#puffer.delete(schluessel);
      this.#puffer.set(schluessel, vorhanden);
      return vorhanden;
    }
    const laden = (async () => {
      const antwort = await this.#u.holen(url);
      if (!antwort.ok) {
        throw antwort.status === 404 || antwort.status === 410
          ? new FehltFehler()
          : new Error(`HTTP ${antwort.status}`);
      }
      const daten = await antwort.arrayBuffer();
      try {
        return await ctx.decodeAudioData(daten);
      } catch {
        throw new Dekodierfehler();
      }
    })();
    this.#puffer.set(schluessel, laden);
    while (this.#puffer.size > PUFFER_GRENZE) {
      const aeltester = this.#puffer.keys().next().value;
      if (aeltester === undefined) break;
      this.#puffer.delete(aeltester);
    }
    // Nur Dekodierfehler bleiben stehen; alles andere darf der nächste Ton
    // neu versuchen.
    laden.catch((e: unknown) => {
      if (!(e instanceof Dekodierfehler) && this.#puffer.get(schluessel) === laden) {
        this.#puffer.delete(schluessel);
      }
    });
    return laden;
  }

  async #wecken(ctx: KontextArtig): Promise<boolean> {
    this.#ruheAbbrechen();
    if (ctx.state === 'running') return true;
    let uhr: ReturnType<typeof setTimeout> | undefined;
    const frist = new Promise<void>((fertig) => {
      uhr = setTimeout(fertig, this.#u.weckFristMs);
    });
    try {
      await Promise.race([ctx.resume().catch(() => undefined), frist]);
    } finally {
      clearTimeout(uhr);
    }
    const laeuft = ctx.state === 'running';
    if (!laeuft) this.#ruheNachHinten();
    return laeuft;
  }

  #abspielen(ctx: KontextArtig, url: string, puffer: PufferArtig, gain: number): void {
    const quelle = ctx.createBufferSource();
    const verstaerker = ctx.createGain();
    quelle.buffer = puffer;
    verstaerker.gain.value = Math.min(1, Math.max(0, gain));
    quelle.connect(verstaerker);
    verstaerker.connect(ctx.destination);
    const liste = this.#laufend.get(url) ?? [];
    if (liste.length >= HOECHSTENS_JE_URL) {
      try {
        liste[0].stop();
      } catch {
        /* schon zu Ende */
      }
    }
    liste.push(quelle);
    this.#laufend.set(url, liste);
    this.#aktiv++;
    quelle.onended = () => {
      quelle.onended = null;
      quelle.disconnect();
      verstaerker.disconnect();
      const rest = (this.#laufend.get(url) ?? []).filter((q) => q !== quelle);
      if (rest.length) this.#laufend.set(url, rest);
      else this.#laufend.delete(url);
      this.#aktiv = Math.max(0, this.#aktiv - 1);
      if (this.#aktiv === 0) this.#ruheNachHinten();
    };
    quelle.start();
  }

  #ruheAbbrechen(): void {
    clearTimeout(this.#ruheUhr);
    this.#ruheUhr = undefined;
  }

  #ruheNachHinten(): void {
    this.#ruheAbbrechen();
    this.#ruheUhr = setTimeout(() => {
      this.#ruheUhr = undefined;
      const ctx = this.#kontext;
      if (ctx && this.#aktiv === 0 && ctx.state === 'running') {
        void ctx.suspend().catch(() => undefined);
      }
    }, this.#u.ruheMs);
  }
}
