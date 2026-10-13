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
        canPlaybackAudio: boolean;
        state: string;
        handleDisconnect: (stopTracks?: boolean) => void;
        on: (e: string, fn: (v: boolean) => void) => void;
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
  async function beitrittNachstellen(page: Page, schuetzen: boolean): Promise<boolean> {
    return page.evaluate(async (schuetzen) => {
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const { startAudioAbbruchfest } = await import('/src/lib/audio/abspielen.ts');
      const raum = new window.LivekitClient.Room();
      raum.state = 'connected'; // ohne `connect()` stünde er auf `disconnected`
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
      return raum.canPlaybackAudio;
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

  test('mit startAudioAbbruchfest() bleibt die Konsole sauber und der Ton frei', async ({ page }) => {
    const fehler = unbehandelteFehler(page);
    const kannAbspielen = await beitrittNachstellen(page, true);
    expect(fehler).toEqual([]);
    expect(kannAbspielen, 'der überholte Versuch darf den Ton nicht als gesperrt zurücklassen').toBe(true);
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

/**
 * Ein überholtes `startAudio()` darf den Ton nicht als gesperrt zurücklassen.
 *
 * LiveKit ruft im `catch` von `startAudio()` für JEDEN Fehler
 * `handleAudioPlaybackFailed()` — auch für `AbortError`: `canPlaybackAudio`
 * kippt auf `false`, `AudioPlaybackStatusChanged(false)` feuert, und Pulse
 * (`livekit.svelte.ts`) setzt daraufhin `voice.audioBlocked` → Overlay „Audio
 * ist stummgeschaltet“, obwohl der Ton läuft. Erst DANACH wirft LiveKit, und
 * erst dort greift `startAudioAbbruchfest`. Die echte Bibliothek läuft gegen ein
 * Element, dessen `play()` nach Drehbuch antwortet (`abbruch` = überholt,
 * `gesperrt` = Autoplay-Sperre, `ok`).
 */
test.describe('startAudio(): Abbruch ist kein gesperrter Ton', () => {
  type Schritt = 'ok' | 'abbruch' | 'gesperrt';
  interface Befund {
    /** `ok` oder der Name des Fehlers, mit dem `startAudio()` geendet hat. */
    ergebnis: string;
    /** Was `room.canPlaybackAudio` danach sagt — daran hängt `voice.audioBlocked`. */
    kannAbspielen: boolean;
    /** Alle `AudioPlaybackStatusChanged`-Werte, in der Reihenfolge. */
    ereignisse: boolean[];
    /** `canPlaybackAudio` zu Beginn jedes Bildes, solange der Lauf dauerte. */
    bildproben: boolean[];
    /** Wie oft `play()` aufgerufen wurde (= Versuche von `startAudio()`). */
    versuche: number;
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.addScriptTag({ path: LIVEKIT_UMD });
  });

  /** `startAudio()` einmal fahren, wie Pulse es beim Beitritt tut. */
  function fahre(page: Page, drehbuch: Schritt[], schuetzen = true): Promise<Befund> {
    return page.evaluate(
      async ({ drehbuch, schuetzen }) => {
        // @ts-expect-error - Vite-served path resolved at browser runtime
        const { startAudioAbbruchfest } = await import('/src/lib/audio/abspielen.ts');
        const raum = new window.LivekitClient.Room();
        raum.state = 'connected'; // ohne `connect()` stünde er auf `disconnected`
        const ereignisse: boolean[] = [];
        raum.on('audioPlaybackChanged', (ok) => ereignisse.push(ok));
        if (schuetzen) startAudioAbbruchfest(raum);
        let versuche = 0;
        const element = {
          muted: true,
          play: () => {
            const schritt = drehbuch[Math.min(versuche++, drehbuch.length - 1)];
            if (schritt === 'ok') return Promise.resolve();
            return Promise.reject(
              schritt === 'abbruch'
                ? new DOMException('The play() request was interrupted by a call to pause().', 'AbortError')
                : new DOMException('play() failed: not allowed', 'NotAllowedError')
            );
          }
        };
        raum.remoteParticipants.set('gegenstelle', {
          audioTrackPublications: new Map([['ton', { track: { attachedElements: [element] } }]]),
          videoTrackPublications: new Map()
        });
        const bildproben: boolean[] = [];
        let laeuft = true;
        const probe = () => {
          bildproben.push(raum.canPlaybackAudio);
          if (laeuft) requestAnimationFrame(probe);
        };
        requestAnimationFrame(probe);
        let ergebnis = 'ok';
        try {
          await raum.startAudio();
        } catch (e) {
          ergebnis = (e as { name?: string }).name ?? String(e);
        }
        await new Promise((r) => setTimeout(r, 150));
        laeuft = false;
        return { ergebnis, kannAbspielen: raum.canPlaybackAudio, ereignisse, bildproben, versuche };
      },
      { drehbuch, schuetzen }
    );
  }

  test('Kontrolle: ohne Schutz lässt der Abbruch den Ton als gesperrt zurück', async ({ page }) => {
    const b = await fahre(page, ['abbruch'], false);
    expect(b.ergebnis).toBe('AbortError');
    expect(b.kannAbspielen, 'Kontrolle: LiveKit kippt hier tatsächlich auf „gesperrt“').toBe(false);
    expect(b.ereignisse).toEqual([false]);
  });

  test('ein überholtes play() wird wiederholt, der Ton gilt danach als frei', async ({ page }) => {
    const b = await fahre(page, ['abbruch', 'ok']);
    expect(b.ergebnis).toBe('ok');
    expect(b.kannAbspielen, 'daran hängt das Overlay „Audio ist stummgeschaltet“').toBe(true);
    expect(b.ereignisse.at(-1)).toBe(true);
    expect(b.bildproben.every(Boolean), 'kein Bild sah „gesperrt“ — das Overlay blitzt nicht auf').toBe(true);
    expect(b.versuche).toBe(2);
  });

  test('ein echter Autoplay-Sperrfehler bleibt gesperrt und wird nicht wiederholt', async ({ page }) => {
    const b = await fahre(page, ['gesperrt']);
    expect(b.ergebnis).toBe('NotAllowedError');
    expect(b.versuche).toBe(1);
    expect(b.kannAbspielen).toBe(false);
    expect(b.ereignisse).toEqual([false]);
  });

  test('Abbruch, dann echte Sperre: die Sperre gewinnt', async ({ page }) => {
    const b = await fahre(page, ['abbruch', 'gesperrt']);
    expect(b.ergebnis).toBe('NotAllowedError');
    expect(b.versuche).toBe(2);
    expect(b.kannAbspielen).toBe(false);
    expect(b.ereignisse.at(-1)).toBe(false);
  });

  test('immer überholt: endet nach wenigen Versuchen und wirft nicht', async ({ page }) => {
    const b = await fahre(page, ['abbruch']);
    expect(b.ergebnis).toBe('ok');
    expect(b.versuche).toBe(3);
  });

  /**
   * Raum wird abgebaut, während `startAudio()` noch auf ein `play()` wartet.
   * LiveKits Abbau (`handleDisconnect`) schließt den AudioContext und setzt den
   * Zustand auf `disconnected`; das `play()` endet danach mit AbortError. Eine
   * Wiederholung legte jetzt einen NEUEN AudioContext an (`acquireAudioContext`),
   * den niemand mehr schließt.
   */
  async function fahreMitAbbau(page: Page, schuetzen: boolean) {
    return page.evaluate(async (schuetzen) => {
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const { startAudioAbbruchfest } = await import('/src/lib/audio/abspielen.ts');
      const kontexte: AudioContext[] = [];
      const Echt = window.AudioContext;
      window.AudioContext = class extends Echt {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args);
          kontexte.push(this);
        }
      };
      const raum = new window.LivekitClient.Room();
      raum.state = 'connected';
      if (schuetzen) startAudioAbbruchfest(raum);
      let versuche = 0;
      let ueberholen: () => void = () => {};
      const element = {
        muted: true,
        play: () => {
          if (versuche++ > 0) return Promise.resolve();
          return new Promise<void>((_, nein) => {
            ueberholen = () =>
              nein(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
          });
        }
      };
      raum.remoteParticipants.set('gegenstelle', {
        trackPublications: new Map(), // liest `handleDisconnect`
        audioTrackPublications: new Map([['ton', { track: { attachedElements: [element] } }]]),
        videoTrackPublications: new Map()
      });
      const lauf = raum.startAudio();
      raum.handleDisconnect(true); // Abbau: schließt den Kontext, Zustand `disconnected`
      ueberholen(); // … und erst dann endet das wartende play()
      let ergebnis = 'ok';
      try {
        await lauf;
      } catch (e) {
        ergebnis = (e as { name?: string }).name ?? String(e);
      }
      await new Promise((r) => setTimeout(r, 200));
      return {
        ergebnis,
        versuche,
        zustand: raum.state,
        kontexte: kontexte.map((k) => k.state)
      };
    }, schuetzen);
  }

  test('Raum mitten im Versuch abgebaut: keine Wiederholung, kein neuer AudioContext', async ({ page }) => {
    const b = await fahreMitAbbau(page, true);
    expect(b.zustand).toBe('disconnected');
    expect(b.ergebnis).toBe('ok');
    expect(b.versuche).toBe(1);
    expect(b.kontexte, 'genau der eine Kontext von vor dem Abbau, und der ist zu').toEqual(['closed']);
  });
});
