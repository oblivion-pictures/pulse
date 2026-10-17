/**
 * Die Brücke zum nativen Stream-Ton der iOS-Hülle (`StreamTonPlugin.swift`):
 * die Kachel reicht ihre WHEP-URL hinein, die Hülle spielt den Ton in einer
 * eigenen kleinen Ton-Maschine — hörbar im Lautlos-Modus und bei gesperrtem
 * Gerät, stereo, wo die Route es kann, und ohne die Session des Sprachkanals
 * anzufassen. Das Bild bleibt in der WebView.
 *
 * **Die Weiche ist das ganze Plugin**, nicht eine Methode: ein Bau ohne
 * `StreamTonPlugin` (2.1, 4.1, …) oder mit unvollständigem Kopf bleibt beim
 * WebView-Ton, wie er heute ist. Ausserhalb der iOS-Hülle (Desktop, Browser,
 * Android) wird nichts davon je betreten.
 *
 * Importe mit `.ts`-Endung, damit Nodes Läufer die Weiche samt echtem
 * `@capacitor/core` lädt (`test/ios-stream-ton-nativ.test.ts`).
 */

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { mitFrist } from './brueckenFrist.ts';
import { huellenBefund } from './huelleKann.ts';
import { nativerSprachwegDa } from './iosSpracheWeiche.ts';

/** Die Fähigkeitsliste — muss mit `pluginMethods` in `StreamTonPlugin.swift`
 *  übereinstimmen (der Test liest beide). */
export const STREAM_TON_METHODEN = [
  'starten',
  'stoppen',
  'lautstaerke',
  'verzoegerung',
  'fortsetzen',
  'statistik'
] as const;

export type StreamTonPhase = 'verbinde' | 'spielt' | 'unterbrochen' | 'beendet' | 'fehler';

export interface StreamTonZustand {
  kennung?: string;
  phase: StreamTonPhase;
  grund?: string;
  /** Wird der Ton gerade abgesenkt (offenes Mikrofon am Lautsprecher)? */
  echoGedaempft?: boolean;
  /** Kanäle der Ausgabe-Hardware (2 = die Route kann stereo). */
  hardwareKanaele?: number;
}

/** Was `statistik` liefert — Zahlen, keine Kennungen. */
export interface StreamTonStatistik {
  jbSumme?: number;
  jbAnzahl?: number;
  ausgabeMs?: number;
  verzoegerungMs?: number;
  codecKanaele?: number;
  pegelL?: number;
  pegelR?: number;
  phase?: StreamTonPhase;
}

interface StreamTonPlugin {
  starten(o: {
    kennung: string;
    url: string;
    lautstaerke: number;
    echoFaktor: number;
  }): Promise<StreamTonZustand>;
  stoppen(o: { kennung: string }): Promise<void>;
  lautstaerke(o: { kennung: string; wert: number }): Promise<void>;
  verzoegerung(o: { kennung: string; ms: number }): Promise<void>;
  fortsetzen(): Promise<void>;
  statistik(o: { kennung: string }): Promise<StreamTonStatistik>;
  addListener(
    e: 'zustand',
    cb: (z: StreamTonZustand) => void
  ): Promise<PluginListenerHandle>;
}

const nativ = registerPlugin<StreamTonPlugin>('StreamTonPlugin');

/** Ein WHEP-Handshake dauert über eine echte Leitung 0,5–2 s (ICE-Sammeln
 *  allein bis 2 s); mit Reserve für einen langsamen Server. */
const START_FRIST_MS = 15_000;
const SOFORT_FRIST_MS = 3_000;

/**
 * Trägt dieser Bau den nativen Stream-Ton — vollständig?
 *
 * **Nur zusammen mit dem nativen Sprachweg** (Gegenprüfung 2026-10-17, S1).
 * Der Stream-Ton erklärt WebKit `ambient`, und unter `ambient` hat eine
 * Aufnahme der WebView keinen Eingang — WebKit nimmt die Übersteuerung VOR
 * der Aufnahme-Regel (`MediaSessionManagerCocoa.mm`). Läuft die Sprache über
 * den Web-Weg (Notschalter `NATIVER_SPRACHWEG_AN`, unvollständiger Bau),
 * nähme schon das Öffnen einer Kachel dem Kanal das Mikrofon — ausgerechnet
 * auf dem Rückweg, den der Notschalter sichern soll. `nativerSprachwegDa`
 * prüft auch die Plattform.
 */
export function streamTonNativDa(): boolean {
  if (!nativerSprachwegDa()) return false;
  return huellenBefund('StreamTonPlugin', STREAM_TON_METHODEN).da;
}

function p(): StreamTonPlugin | null {
  return streamTonNativDa() ? nativ : null;
}

export async function streamTonStarten(
  kennung: string,
  url: string,
  lautstaerke: number,
  echoFaktor: number
): Promise<StreamTonZustand> {
  const plugin = p();
  if (!plugin) throw new Error('streamton_fehlt');
  return mitFrist(
    plugin.starten({ kennung, url, lautstaerke, echoFaktor }),
    START_FRIST_MS,
    'streamton.starten'
  );
}

export async function streamTonStoppen(kennung: string): Promise<void> {
  const plugin = p();
  if (plugin) await mitFrist(plugin.stoppen({ kennung }), SOFORT_FRIST_MS, 'streamton.stoppen');
}

export function streamTonLautstaerke(kennung: string, wert: number): void {
  void p()?.lautstaerke({ kennung, wert }).catch(() => undefined);
}

export function streamTonVerzoegerung(kennung: string, ms: number): void {
  void p()?.verzoegerung({ kennung, ms }).catch(() => undefined);
}

export function streamTonFortsetzen(): void {
  void p()?.fortsetzen().catch(() => undefined);
}

export async function streamTonStatistik(kennung: string): Promise<StreamTonStatistik | null> {
  const plugin = p();
  if (!plugin) return null;
  try {
    return await mitFrist(plugin.statistik({ kennung }), SOFORT_FRIST_MS, 'streamton.statistik');
  } catch {
    return null;
  }
}

/**
 * Auf Zustandswechsel aller Empfänger hören (ein Hörer für die ganze App,
 * verteilt nach `kennung`). Capacitor räumt Hörer bei jeder Navigation der
 * WebView ab; ein Neuladen baut die Kacheln ohnehin neu.
 */
const hoerer = new Map<string, (z: StreamTonZustand) => void>();
let angemeldet = false;

export function streamTonHoeren(kennung: string, cb: (z: StreamTonZustand) => void): () => void {
  hoerer.set(kennung, cb);
  const plugin = p();
  if (plugin && !angemeldet) {
    angemeldet = true;
    void plugin
      .addListener('zustand', (z) => {
        if (z.kennung) hoerer.get(z.kennung)?.(z);
      })
      .catch(() => {
        angemeldet = false;
      });
  }
  return () => {
    if (hoerer.get(kennung) === cb) hoerer.delete(kennung);
  };
}
