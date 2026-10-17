/**
 * Der native Stream-Ton EINER Kachel (iOS-Hülle mit `StreamTonPlugin`): wann
 * er startet, wann neu, wann er aufgibt und der WebView-Ton übernimmt.
 *
 * **Warum nativ.** Solange ein nativer Raum steht, ist WebKits Session
 * `ambient` — der WebView-Ton einer Übertragung folgte dem Stummschalter und
 * endete beim Sperren. Ein nicht mischbarer WebView-Ton nähme der Hülle
 * dagegen Session und Mikrofon (Kette K1). Nativ gespielt gilt beides nicht
 * (Begründung und Session-Regeln: `StreamTonSitzung.swift`). In der Hülle mit
 * Fähigkeit läuft der Ton deshalb IMMER nativ, nicht nur im Sprachkanal —
 * sonst gäbe es beim Betreten und Verlassen eine Übergabe mit Lücke.
 *
 * **Lebenslauf.** Die Kachel ruft `verbinden(url)` bei jeder neuen
 * WebView-Sitzung. Derselbe Pfad mit laufendem Ton → nichts (ein Wiederaufbau
 * der Bildsitzung, etwa nach einem Einfrieren, lässt den Ton stehen); ein
 * neuer Pfad (neue Übertragung, Republish) → neu. Scheitert der native Weg,
 * holt er eine FRISCHE URL (das Lese-Token lebt 10 min) und versucht es
 * erneut; nach `VERSUCHE` Fehlschlägen ohne einen einzigen Erfolg gibt er auf
 * (`rueckfall`), und die Kachel spielt den Ton wieder selbst.
 *
 * **WebKit und `iosTon`** halten sich heraus, solange mindestens eine Kachel
 * nativ spielt: Halter `streamton` (`platform/iosSprache.ts`).
 */

import { nativerTonHalten } from '$lib/platform/iosSprache';
import {
  streamTonAufraeumen,
  streamTonFortsetzen,
  streamTonHoeren,
  streamTonLautstaerke,
  streamTonNativDa,
  streamTonStarten,
  streamTonStatistik,
  streamTonStoppen,
  streamTonVerzoegerung,
  type StreamTonPhase,
  type StreamTonZustand
} from '$lib/platform/iosStreamTonNativ';
import { WebAufnahme, type Geraete } from '$lib/platform/webAufnahme';
import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { tonWiedergabenBeobachten } from '$lib/platform/iosTon';
import {
  mikrofonBeiDerHuelle,
  mikrofonBeiDerHuelleBeobachten
} from '$lib/platform/mikrofonBeiDerHuelle';
import { StreamTonLage, type Lage, type Teilnehmer } from './streamTonLage';
import { melde } from '$lib/diagnose/app-diagnose';
import {
  fensterMs,
  versatzEntscheiden,
  videoZaehler,
  whepHostErlaubt,
  whepPfad,
  type Zaehler
} from './tonVersatz';

/**
 * Absenkung bei offenem Mikrofon am eingebauten Lautsprecher: −12 dB.
 *
 * Der native Ton liegt in keiner Echo-Referenz (`StreamTonSitzung.echoLage`).
 * −12 dB nimmt dem Rückweg über das Telefonmikrofon drei Viertel der Amplitude
 * — genug, dass Apples Rausch- und Echo-Verarbeitung den Rest meist als
 * Hintergrund behandelt, und wenig genug, dass man die Übertragung am
 * Lautsprecher noch gut hört. **Gesetzt, nicht gemessen**; die Echo-Probe am
 * Gerät entscheidet (zeigt sie, dass VPIO den Ton von selbst abzieht: 1).
 * Hier, nicht in der Hülle, damit ein neuer Wert ohne neuen Bau ankommt.
 */
export const ECHO_FAKTOR = 0.25;
const VERSUCHE = 3;
const RUECKZUG_MS = [1000, 3000, 5000];
/** Höchstens alle 5 s abgleichen — die Fenster brauchen Inhalt. */
const ABGLEICH_MS = 5000;

/** Halter und Lage für alle Kacheln (`streamTonLage.ts`). */
const lage = new StreamTonLage((an) => nativerTonHalten('streamton', an));

// Beim Laden des Moduls einmal aufräumen, was eine frühere Seite nativ
// gestartet hat (S2).
void streamTonAufraeumen();
if (streamTonNativDa()) {
  // Jede Aufnahme der WebView lässt den Halter fallen (S1, `webAufnahme.ts`).
  // Schon beim Laden des Moduls: eine Aufnahme, die vor der ersten Kachel
  // begann, soll genauso zählen.
  if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
    new WebAufnahme((a) => lage.setzen({ aufnahme: a })).einhaengen(
      navigator.mediaDevices as unknown as Geraete
    );
  }
  // Ein eigener Ton der WebView ausserhalb eines Raums (Watch-Party, Kachel im
  // Rückfall) verträgt sich nicht mit dem nativen (S8, `streamTonLage.ts`).
  // „Raum" = dieselben Halter, die das Mikrofon der Hülle zusprechen.
  lage.setzen({ raum: mikrofonBeiDerHuelle() });
  mikrofonBeiDerHuelleBeobachten((raum) => lage.setzen({ raum }));
  tonWiedergabenBeobachten((webWiedergabe) => lage.setzen({ webWiedergabe }));
}

export interface NativStand {
  phase: StreamTonPhase;
  echoGedaempft: boolean;
  /** 2 = die Route kann stereo. */
  hardwareKanaele: number;
}

export class NativerStreamTon implements Teilnehmer {
  readonly #kennung: string;
  readonly #neueUrl: () => Promise<string | null>;
  readonly #stand: (s: NativStand) => void;
  readonly #rueckfall: (grund: string) => void;
  #pfad: string | null = null;
  #lautstaerke = 1;
  #fehlschlaege = 0;
  #gen = 0;
  #beendet = false;
  #aufgegeben = false;
  #retry: ReturnType<typeof setTimeout> | undefined;
  /** Ausgesetzt, solange die Lage es verlangt (Aufnahme der WebView); läuft
   *  danach mit frischer URL wieder an. */
  #pausiert = false;
  #abhoeren: (() => void) | null = null;
  // A/V-Ausgleich
  #letzterAbgleich = 0;
  #video: { puffer: Zaehler; dekodieren: Zaehler } | null = null;
  #ton: Zaehler | null = null;
  #vorschlag: number | null = null;
  #verzoegerung = 0;
  #seitAenderung = 0;

  constructor(
    kennung: string,
    o: {
      neueUrl: () => Promise<string | null>;
      stand: (s: NativStand) => void;
      rueckfall: (grund: string) => void;
    }
  ) {
    this.#kennung = kennung;
    this.#neueUrl = o.neueUrl;
    this.#stand = o.stand;
    this.#rueckfall = o.rueckfall;
    lage.anmelden(this);
  }

  lageSetzen(l: Lage): void {
    if (this.#aufgegeben || this.#beendet) return;
    if (l === 'rueckfall') {
      // Bis die Kachel neu aufgeht: ein Hin und Her zwischen den Wegen kostete
      // je eine Lücke, und die WebView spielt ohnehin schon selbst.
      this.#aufgegeben = true;
      this.#pausiert = false;
      void this.#halt().then(() => this.#rueckfall('webview_spielt'));
      return;
    }
    if (l === 'pause') {
      if (this.#pfad === null && this.#retry === undefined) return;
      this.#pausiert = true;
      this.#gen++;
      clearTimeout(this.#retry);
      this.#retry = undefined;
      this.#pfad = null;
      lage.wollen(this, false);
      this.#stand({ phase: 'verbinde', echoGedaempft: false, hardwareKanaele: 0 });
      void streamTonStoppen(this.#kennung).catch(() => undefined);
    } else if (l === 'nativ' && this.#pausiert) {
      this.#pausiert = false;
      void this.#mitFrischerUrl(++this.#gen);
    }
  }

  /** Spielt der native Weg (oder versucht es noch)? `false` nach dem Aufgeben. */
  get zustaendig(): boolean {
    return !this.#aufgegeben && !this.#beendet && lage.lage !== 'rueckfall';
  }

  verbinden(url: string, lautstaerke: number): void {
    if (!this.zustaendig) return;
    this.#lautstaerke = lautstaerke;
    const pfad = whepPfad(url);
    if (pfad === this.#pfad) return;
    this.#fehlschlaege = 0;
    if (lage.lage === 'pause') {
      this.#pausiert = true;
      return;
    }
    void this.#starten(url, pfad);
  }

  lautstaerke(wert: number): void {
    this.#lautstaerke = wert;
    if (this.#pfad) streamTonLautstaerke(this.#kennung, wert);
  }

  /** „Ton aktivieren" auf der Kachel — die Maschine steht nach einer
   *  Unterbrechung, die kein Ende meldete. */
  fortsetzen(): void {
    streamTonFortsetzen();
  }

  async beenden(): Promise<void> {
    this.#beendet = true;
    await this.#halt();
    lage.abmelden(this);
  }

  async #halt(): Promise<void> {
    this.#gen++;
    clearTimeout(this.#retry);
    this.#abhoeren?.();
    this.#abhoeren = null;
    this.#pfad = null;
    try {
      await streamTonStoppen(this.#kennung);
    } catch {
      /* Frist — die Hülle räumt beim nächsten Start derselben Kennung ab */
    }
    lage.wollen(this, false);
  }

  async #starten(url: string, pfad: string): Promise<void> {
    const seite = typeof location !== 'undefined' ? location.origin : undefined;
    if (!whepHostErlaubt(url, [CLOUD_HOSTNAME, activeServer.current?.hostname, seite])) {
      // Kein Wiederholen: eine fremde Adresse wird beim nächsten Mal nicht
      // eigen. Die Kachel spielt den Ton selbst.
      this.#aufgegeben = true;
      melde('stream', 'stream_nativ_ton_fehler', 'Nativer Stream-Ton: fremder Host', {});
      void this.#halt().then(() => this.#rueckfall('host'));
      return;
    }
    const gen = ++this.#gen;
    clearTimeout(this.#retry);
    this.#pfad = pfad;
    this.#verzoegerung = 0;
    this.#video = null;
    this.#ton = null;
    // ERST halten, dann starten: `iosTon` fasst die Session ab hier nicht
    // mehr an, und WebKit erklärt sich `ambient`.
    lage.wollen(this, true);
    this.#abhoeren ??= streamTonHoeren(this.#kennung, (z) => this.#ereignis(z));
    try {
      const z = await streamTonStarten(this.#kennung, url, this.#lautstaerke, ECHO_FAKTOR);
      if (gen !== this.#gen) return;
      this.#melden(z);
    } catch (e) {
      if (gen !== this.#gen) return;
      const status = (e as { data?: { status?: number } })?.data?.status ?? 0;
      this.#fehlschlag(`start_${status}`);
    }
  }

  #ereignis(z: StreamTonZustand): void {
    // Nach dem Aufgeben kommt das `beendet` des Abbaus oft erst NACH dem
    // Rückfall an — es darf den WebView-Ton nicht wieder als nativ ausgeben.
    if (!this.zustaendig) return;
    this.#melden(z);
    if (z.phase === 'spielt') this.#fehlschlaege = 0;
    if (z.phase === 'fehler' && this.#pfad) this.#fehlschlag(z.grund ?? 'fehler');
  }

  #melden(z: StreamTonZustand): void {
    this.#stand({
      phase: z.phase,
      echoGedaempft: z.echoGedaempft === true,
      hardwareKanaele: z.hardwareKanaele ?? 0
    });
  }

  #fehlschlag(grund: string): void {
    this.#fehlschlaege += 1;
    melde('stream', 'stream_nativ_ton_fehler', `Nativer Stream-Ton: ${grund}`, {
      versuch: this.#fehlschlaege
    });
    const gen = ++this.#gen;
    this.#pfad = null;
    if (this.#fehlschlaege > VERSUCHE) {
      this.#aufgegeben = true;
      void this.#halt().then(() => this.#rueckfall(grund));
      return;
    }
    const warten = RUECKZUG_MS[Math.min(this.#fehlschlaege - 1, RUECKZUG_MS.length - 1)];
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#mitFrischerUrl(gen);
    }, warten);
  }

  async #mitFrischerUrl(gen: number): Promise<void> {
    if (gen !== this.#gen || !this.zustaendig) return;
    const url = await this.#neueUrl();
    if (gen !== this.#gen || !this.zustaendig || this.#pausiert) return;
    // Keine URL (Netz weg, 5xx bei `GET /whep`) ist ein Fehlschlag wie jeder
    // andere — sonst bliebe die Kachel stumm, ohne Versuch und ohne Rückfall,
    // und die Audiospur der WebView aus (Gegenprüfung S6).
    if (!url) {
      this.#fehlschlag('url');
      return;
    }
    void this.#starten(url, whepPfad(url));
  }

  /**
   * A/V-Ausgleich, aus dem Statistik-Takt der Kachel gerufen (`pc` = die
   * Bildsitzung der WebView). Rechnung und Grenzen: `tonVersatz.ts`.
   */
  async abgleich(pc: RTCPeerConnection): Promise<void> {
    const jetzt = performance.now();
    if (!this.#pfad || jetzt - this.#letzterAbgleich < ABGLEICH_MS) return;
    this.#letzterAbgleich = jetzt;
    const gen = this.#gen;
    const [bericht, ton] = await Promise.all([
      pc.getStats().catch(() => null),
      streamTonStatistik(this.#kennung)
    ]);
    if (gen !== this.#gen || !bericht || !ton || ton.phase !== 'spielt') return;
    const video = videoZaehler(bericht.values() as Iterable<Record<string, unknown>>);
    const tonZ = { summe: ton.jbSumme ?? 0, anzahl: ton.jbAnzahl ?? 0 };
    const vPuffer = video ? fensterMs(this.#video?.puffer ?? null, video.puffer) : null;
    const vDekod = video ? fensterMs(this.#video?.dekodieren ?? null, video.dekodieren) : null;
    const tPuffer = fensterMs(this.#ton, tonZ);
    this.#video = video;
    this.#ton = tonZ;
    if (vPuffer === null || tPuffer === null) return;
    const lage = {
      videoMs: vPuffer + (vDekod ?? 0),
      tonMs: tPuffer + (ton.ausgabeMs ?? 0),
      aktuellMs: this.#verzoegerung,
      vorschlagVorher: this.#vorschlag,
      seitAenderungMs: jetzt - this.#seitAenderung
    };
    const { vorschlag, setzen } = versatzEntscheiden(lage);
    this.#vorschlag = vorschlag;
    if (setzen === null) return;
    this.#verzoegerung = setzen;
    this.#seitAenderung = jetzt;
    streamTonVerzoegerung(this.#kennung, setzen);
    melde('stream', 'stream_nativ_ton_versatz', `Ton um ${setzen} ms verzögert`, {
      video_ms: Math.round(lage.videoMs),
      ton_ms: Math.round(lage.tonMs)
    });
  }
}

/**
 * Den Ton der WebView-Sitzung ab- oder wieder anschalten. Abgeschaltete
 * Spuren spielt WebKit nicht ab — auch nicht stumm über ein Element —, also
 * richtet es für sie auch keine eigene Audio-Session ein.
 */
export function webViewTonAbschalten(stream: MediaStream, aus: boolean): void {
  for (const t of stream.getAudioTracks()) t.enabled = !aus;
}
