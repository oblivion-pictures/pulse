/**
 * Sprachnachricht-Aufnahme (P0.3): getUserMedia + MediaRecorder, Audio-only.
 *
 * Der kleinste Weg: am Ende steht eine `File`, die in den BESTEHENDEN
 * Anhang-Weg geschoben wird (`MessageInput.addFiles` → Klartext-Upload bzw.
 * verschlüsselter DM-Weg) — keine zweite Pipeline. Der MIME wird bereinigt
 * (`audioMimeBereinigen`), weil die Server-Allowlist ohne Parameter-Tail
 * matcht; Safari liefert `audio/mp4`, Chrome/WebView `audio/webm`.
 *
 * Chunk-Sammlung und `onstop` hängen an `starteAufnahme` — der 300-s-Wecker
 * ruft denselben Stop-Pfad auf wie das Loslassen und darf nichts verlieren
 * (Simplifier-Befund: handlerloses `stop()` verschluckte die 5-Minuten-
 * Aufnahme). Der Wiedereinstieg nach Ablehnung: `getUserMedia` wirft, der
 * Composer zeigt einen Toast; ein zweites Halten fragt erneut.
 */
import { aufnahmeGesperrt } from '$lib/platform/aufnahmeSperre';
import {
  AUFGABE_MAX_SEKUNDEN,
  aufnahmeDauerRegister,
  audioMimeBereinigen,
  aufnahmeDateiname
} from './aufnahmeKern';

/** Der beste vom Browser angebotene Aufnahme-Container, parametrisch. */
function besterMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const kandidaten = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return kandidaten.find((m) => MediaRecorder.isTypeSupported(m));
}

export interface LaufendeAufnahme {
  recorder: MediaRecorder;
  stream: MediaStream;
  /** Start der Aufnahme, um jede Pause nach hinten verschoben — die
   *  Differenz zu „jetzt" ist damit die aufgenommene Zeit. */
  gestartetAm: number;
  /** Beginn der laufenden Pause, sonst undefined. */
  pausiertSeit?: number;
  teile: Blob[];
  wecker: ReturnType<typeof setTimeout>;
  /** Stoppt die Aufnahme — derselbe Pfad für Loslassen und 300-s-Wecker. */
  stoppen: () => void;
}

export async function starteAufnahme(): Promise<LaufendeAufnahme> {
  const mime = besterMime();
  if (!mime) throw new Error('AUDIO_RECORDING_UNSUPPORTED');
  // Rückhalt: die Oberfläche fängt es vorher ab (`SprachAufnahme.starten`).
  if (aufnahmeGesperrt('ton')) throw new Error('AUFNAHME_IM_SPRACHKANAL_GESPERRT');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const lauf: LaufendeAufnahme = {
    recorder,
    stream,
    gestartetAm: Date.now(),
    teile: [],
    wecker: setTimeout(() => lauf.stoppen(), AUFGABE_MAX_SEKUNDEN * 1000),
    stoppen: () => {
      if (lauf.recorder.state !== 'inactive') lauf.recorder.stop();
    }
  };
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) lauf.teile.push(e.data);
  };
  recorder.start();
  return lauf;
}

/** Stoppt und liefert die fertige Datei — `null`, wenn nichts Brauchbares
 *  aufgezeichnet wurde (sofortiges Loslassen, abgebrochener Recorder). */
export function beendeAufnahme(lauf: LaufendeAufnahme): Promise<File | null> {
  clearTimeout(lauf.wecker);
  const mime = audioMimeBereinigen(lauf.recorder.mimeType);
  const gestartet = lauf.gestartetAm;
  // Endet die Aufnahme in einer Pause, zählt die Pause nicht mit.
  const ende = lauf.pausiertSeit ?? Date.now();
  return new Promise((resolve) => {
    const fertig = () => {
      lauf.stream.getTracks().forEach((t) => t.stop());
      const dauerSek = (ende - gestartet) / 1000;
      if (lauf.teile.length === 0 || dauerSek < 0.5) {
        resolve(null);
        return;
      }
      const datei = new File([new Blob(lauf.teile, { type: mime })], aufnahmeDateiname(mime), {
        type: mime
      });
      // Echte Dauer merken — der WebM-Container traegt keine, und der
      // Metadataen-Seek im Player luegt groesszuegig (aufgeblaehte Werte).
      aufnahmeDauerRegister.set(datei, dauerSek);
      resolve(datei);
    };
    // Schon gestoppt: der 300-s-Wecker kam dem Ticker zuvor. `onstop` käme
    // nie mehr; die Teile sind da, weil der Ticker erst bis zu einem Takt
    // (500 ms) nach dem Wecker hier ankommt.
    if (lauf.recorder.state === 'inactive') {
      fertig();
      return;
    }
    lauf.recorder.onstop = fertig;
    lauf.stoppen();
  });
}

/** Verwirft: Wecker + Tracks stoppen, keine Datei. */
export function brichAufnahmeAb(lauf: LaufendeAufnahme): void {
  clearTimeout(lauf.wecker);
  lauf.recorder.onstop = null;
  lauf.stoppen();
  lauf.stream.getTracks().forEach((t) => t.stop());
}

/** Pause: der Recorder hält an, der 300-s-Wecker auch — eine Pause zählt
 *  nicht gegen den Rahmen. */
export function pausiereAufnahme(lauf: LaufendeAufnahme): void {
  if (lauf.recorder.state !== 'recording') return;
  lauf.recorder.pause();
  clearTimeout(lauf.wecker);
  lauf.pausiertSeit = Date.now();
}

/** Weiter: der Start rückt um die Pausenlänge nach, der Wecker bekommt die
 *  verbliebene Zeit. */
export function setzeAufnahmeFort(lauf: LaufendeAufnahme): void {
  if (lauf.recorder.state !== 'paused' || lauf.pausiertSeit === undefined) return;
  lauf.gestartetAm += Date.now() - lauf.pausiertSeit;
  lauf.pausiertSeit = undefined;
  const rest = AUFGABE_MAX_SEKUNDEN * 1000 - (Date.now() - lauf.gestartetAm);
  lauf.wecker = setTimeout(() => lauf.stoppen(), Math.max(0, rest));
  lauf.recorder.resume();
}
