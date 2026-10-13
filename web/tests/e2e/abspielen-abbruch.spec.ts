/**
 * `play()` überholt von `pause()` — kein „Uncaught (in promise) AbortError“
 * mehr in der Konsole.
 *
 * Einen echten Sprachkanal-Beitritt kann die Suite nicht fahren (kein LiveKit
 * unter Test, s. `overnight-voice.spec.ts`). Nachgestellt wird deshalb der
 * Mechanismus, den die LiveKit-Bibliothek selbst mitbringt: beim Beitritt
 * (Ereignis `AudioStreamAcquired`, das eigene Mikrofon steht) ruft `Room` ihr
 * `startAudio()` auf und wirft das Promise weg. `startAudio()` spielt dabei
 * jedes Element ab, das an ein Audio-Track angehängt ist (`track.attach()`:
 * Ton einer Bildschirmfreigabe, Anruf-/Gast-Räume); pausiert LiveKit dasselbe
 * Element im selben Augenblick selbst (`detach()` → `recycleElement()`),
 * lehnt es mit AbortError ab. Die echte Bibliothek (UMD-Bau aus
 * `node_modules`) läuft dazu gegen eine Fake-Gegenstelle im Seiten-Kontext;
 * die Schutzfunktion kommt über den Vite-Dev-Server aus dem App-Quelltext.
 *
 * Der Kontrolllauf OHNE Schutz ist Absicht: er beweist, dass diese Umgebung
 * den Fehler überhaupt erzeugt (sonst wäre „kein Fehler“ nichts wert). Wird er
 * rot, hat LiveKit den Abbruch selbst abgefangen — dann können
 * `startAudioAbbruchfest` und dieser Kontrolllauf weg.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const LIVEKIT_UMD = path.resolve(process.cwd(), 'node_modules/livekit-client/dist/livekit-client.umd.js');

declare global {
  interface Window {
    LivekitClient: {
      Room: new () => {
        startAudio: () => Promise<void>;
        remoteParticipants: Map<string, unknown>;
        localParticipant: { emit: (e: string) => void };
        setupLocalParticipantEvents: () => void;
      };
    };
  }
}

/** Fehler der Seite, die KEIN Aufrufer abgefangen hat. */
function unbehandelteFehler(page: Page): string[] {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  return fehler;
}

test.describe('play() und sein Abbruch', () => {
  test.beforeEach(async ({ page }) => {
    // Irgendeine Seite der App genügt: der Vite-Dev-Server liefert von dort
    // `/src/…`. Das Login braucht keine Anmeldung.
    await page.goto('/login');
    await page.addScriptTag({ path: LIVEKIT_UMD });
  });

  /** Beitritt nachstellen: Ereignis feuern, im selben Zug pausiert LiveKit. */
  async function beitrittNachstellen(page: Page, schuetzen: boolean): Promise<void> {
    await page.evaluate(async (schuetzen) => {
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const { startAudioAbbruchfest } = await import('/src/lib/audio/abspielen.ts');
      const raum = new window.LivekitClient.Room();
      if (schuetzen) startAudioAbbruchfest(raum);
      const ctx = new AudioContext();
      const el = document.createElement('audio');
      el.srcObject = ctx.createMediaStreamDestination().stream;
      document.body.appendChild(el);
      // Gegenstelle mit einem von `track.attach()` angehängten Element.
      raum.remoteParticipants.set('gegenstelle', {
        audioTrackPublications: new Map([['ton', { track: { attachedElements: [el] } }]]),
        videoTrackPublications: new Map()
      });
      // `connect()` verdrahtet das Ereignis; hier ohne Server von Hand.
      raum.setupLocalParticipantEvents();
      raum.localParticipant.emit('audioStreamAcquired');
      el.pause(); // `detach()` → `recycleElement()` in LiveKit
      await new Promise((r) => setTimeout(r, 400));
    }, schuetzen);
  }

  test('Kontrolle: LiveKits startAudio() lässt den Abbruch unbehandelt', async ({ page }) => {
    const fehler = unbehandelteFehler(page);
    await beitrittNachstellen(page, false);
    expect(
      fehler.some((f) => f.includes('play() request was interrupted by a call to pause()')),
      'ohne Schutz muss der Abbruch als unbehandelt auftauchen — sonst fängt LiveKit ihn jetzt selbst'
    ).toBe(true);
  });

  test('mit startAudioAbbruchfest() bleibt die Konsole sauber', async ({ page }) => {
    const fehler = unbehandelteFehler(page);
    await beitrittNachstellen(page, true);
    expect(fehler).toEqual([]);
  });

  test('spieleAb(): ein überholtes play() ist kein Fehler, ein nacktes schon', async ({ page }) => {
    const fehler = unbehandelteFehler(page);
    const abbruch = () => fehler.filter((f) => f.includes('play() request was interrupted'));
    const spielen = (mitHelfer: boolean) =>
      page.evaluate(async (mitHelfer) => {
        // @ts-expect-error - Vite-served path resolved at browser runtime
        const { spieleAb } = await import('/src/lib/audio/abspielen.ts');
        const el = document.createElement('audio');
        el.srcObject = new AudioContext().createMediaStreamDestination().stream;
        document.body.appendChild(el);
        // Das nackte `void el.play()` stand so in AudioNachricht/KameraOverlay.
        if (mitHelfer) void spieleAb(el);
        else void el.play();
        el.pause();
        await new Promise((r) => setTimeout(r, 300));
      }, mitHelfer);

    await spielen(true);
    expect(abbruch()).toHaveLength(0);
    await spielen(false);
    expect(abbruch(), 'Kontrolle: das nackte play() erzeugt den Fehler hier wirklich').toHaveLength(1);
  });
});
