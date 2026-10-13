/**
 * `play()` und sein Abbruch (Konsole: „Uncaught (in promise) AbortError: The
 * play() request was interrupted by a call to pause()").
 *
 * Zwei Quellen, beide behandelt:
 *  - eigene Aufrufe ohne `.catch` (`spieleAb`),
 *  - LiveKits eigenes `Room.startAudio()`, das beim Beitritt (Ereignis
 *    `AudioStreamAcquired`) ohne Fänger läuft und an `track.attach()`-Elemente
 *    stößt (`startAudioAbbruchfest`). Der Browser-Nachweis dazu steht in
 *    `tests/e2e/abspielen-abbruch.spec.ts`.
 *
 * Dazu die Folge für den Ton-gesperrt-Zustand: LiveKit setzt
 * `canPlaybackAudio=false` (und feuert `AudioPlaybackStatusChanged`) schon
 * BEVOR `startAudio()` wirft — ein überholter Versuch ließe das Overlay „Audio
 * ist stummgeschaltet" also stehen. Der Wrapper wiederholt ihn deshalb; ein
 * echter Fehler (Autoplay gesperrt) kommt unverändert an und bleibt gesperrt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  folgeNachFehler,
  istAbspielAbbruch,
  spieleAb,
  startAudioAbbruchfest,
} from '../src/lib/audio/abspielen.ts';

const abbruch = () =>
  new DOMException('The play() request was interrupted by a call to pause().', 'AbortError');
const gesperrt = () => new DOMException('play() failed: not allowed', 'NotAllowedError');

describe('istAbspielAbbruch', () => {
  test('AbortError ja, alles andere nein', () => {
    assert.equal(istAbspielAbbruch(abbruch()), true);
    assert.equal(istAbspielAbbruch(gesperrt()), false);
    assert.equal(istAbspielAbbruch(new Error('boom')), false);
    assert.equal(istAbspielAbbruch(null), false);
    assert.equal(istAbspielAbbruch(undefined), false);
    assert.equal(istAbspielAbbruch('AbortError'), false);
  });
});

describe('folgeNachFehler', () => {
  test('Abbruch mit Versuchen übrig → wiederholen', () => {
    assert.equal(folgeNachFehler(abbruch(), 0, 2), 'wiederholen');
    assert.equal(folgeNachFehler(abbruch(), 1, 2), 'wiederholen');
  });

  test('Abbruch ohne Versuche übrig → verwerfen (kein Fehler)', () => {
    assert.equal(folgeNachFehler(abbruch(), 2, 2), 'verwerfen');
    assert.equal(folgeNachFehler(abbruch(), 0, 0), 'verwerfen');
  });

  test('alles andere → weiterreichen, auch wenn Versuche übrig sind', () => {
    assert.equal(folgeNachFehler(gesperrt(), 0, 2), 'weiterreichen');
    assert.equal(folgeNachFehler(new Error('boom'), 0, 2), 'weiterreichen');
    assert.equal(folgeNachFehler(undefined, 0, 2), 'weiterreichen');
  });
});

describe('spieleAb', () => {
  test('gelungenes play() → fertig', async () => {
    await spieleAb({ play: () => Promise.resolve() });
  });

  test('überholtes play() (AbortError) endet still', async () => {
    await spieleAb({ play: () => Promise.reject(abbruch()) });
  });

  test('Autoplay gesperrt (NotAllowedError) bleibt sichtbar', async () => {
    const schuld = gesperrt();
    await assert.rejects(
      spieleAb({ play: () => Promise.reject(schuld) }),
      (e: unknown) => e === schuld,
    );
  });

  test('jeder andere Fehler geht durch', async () => {
    const schuld = new DOMException('kaputt', 'NotSupportedError');
    await assert.rejects(
      spieleAb({ play: () => Promise.reject(schuld) }),
      (e: unknown) => e === schuld,
    );
  });
});

describe('startAudioAbbruchfest', () => {
  test('AbortError aus startAudio() wird verschluckt', async () => {
    const raum = { startAudio: () => Promise.reject(abbruch()) };
    startAudioAbbruchfest(raum);
    await raum.startAudio();
  });

  test('andere Fehler kommen unverändert an', async () => {
    const schuld = gesperrt();
    const raum = { startAudio: () => Promise.reject(schuld) };
    startAudioAbbruchfest(raum);
    await assert.rejects(raum.startAudio(), (e: unknown) => e === schuld);
  });

  test('Erfolg bleibt Erfolg, und das Original läuft genau einmal je Aufruf', async () => {
    let aufrufe = 0;
    const raum = {
      startAudio: async () => {
        aufrufe++;
      },
    };
    startAudioAbbruchfest(raum);
    await raum.startAudio();
    assert.equal(aufrufe, 1);
  });
});

describe('startAudioAbbruchfest: ein überholter Versuch hinterlässt keinen gesperrten Ton', () => {
  /** Nimmt LiveKits `startAudio()` nach: der Fehler setzt den Zustand schon,
   *  BEVOR er geworfen wird (`handleAudioPlaybackFailed`), ein Erfolg setzt ihn
   *  zurück. `drehbuch` = Ausgang je Versuch (der letzte gilt weiter). */
  function livekitRaum(drehbuch: Array<'ok' | 'abbruch' | 'gesperrt'>) {
    const sperre = gesperrt();
    const raum = {
      canPlaybackAudio: true,
      sperre,
      versuche: 0,
      dieses: undefined as unknown,
      ereignisse: [] as boolean[],
      startAudio: async function (this: unknown) {
        raum.dieses = this;
        const schritt = drehbuch[Math.min(raum.versuche++, drehbuch.length - 1)];
        if (schritt === 'ok') {
          if (!raum.canPlaybackAudio) {
            raum.canPlaybackAudio = true;
            raum.ereignisse.push(true);
          }
          return;
        }
        if (raum.canPlaybackAudio) {
          raum.canPlaybackAudio = false;
          raum.ereignisse.push(false);
        }
        throw schritt === 'abbruch' ? abbruch() : sperre;
      },
    };
    return raum;
  }
  /** Das Overlay hängt an genau dieser Rechnung (`livekit.svelte.ts`). */
  const overlay = (raum: { canPlaybackAudio: boolean }) => !raum.canPlaybackAudio;

  test('einmal überholt, dann Erfolg: kein Overlay, zwei Versuche', async () => {
    const raum = livekitRaum(['abbruch', 'ok']);
    startAudioAbbruchfest(raum);
    await raum.startAudio();
    assert.equal(overlay(raum), false);
    assert.equal(raum.versuche, 2);
    assert.equal(raum.ereignisse.at(-1), true);
  });

  test('Gegenprobe: ohne Wrapper bliebe das Overlay stehen', async () => {
    const raum = livekitRaum(['abbruch', 'ok']);
    await assert.rejects(raum.startAudio());
    assert.equal(overlay(raum), true);
  });

  test('echte Sperre: genau ein Versuch, Fehler kommt an, Overlay bleibt', async () => {
    const raum = livekitRaum(['gesperrt']);
    startAudioAbbruchfest(raum);
    await assert.rejects(raum.startAudio(), (e: unknown) => e === raum.sperre);
    assert.equal(raum.versuche, 1);
    assert.equal(overlay(raum), true);
  });

  test('überholt, dann gesperrt: die Sperre gewinnt', async () => {
    const raum = livekitRaum(['abbruch', 'gesperrt']);
    startAudioAbbruchfest(raum);
    await assert.rejects(raum.startAudio(), (e: unknown) => e === raum.sperre);
    assert.equal(raum.versuche, 2);
    assert.equal(overlay(raum), true);
  });

  test('immer überholt: nach drei Versuchen endet es still, ohne Fehler', async () => {
    const raum = livekitRaum(['abbruch']);
    startAudioAbbruchfest(raum);
    await raum.startAudio();
    assert.equal(raum.versuche, 3);
  });

  test('das Original läuft am Raum (this), auch bei der Wiederholung', async () => {
    const raum = livekitRaum(['abbruch', 'ok']);
    startAudioAbbruchfest(raum);
    await raum.startAudio();
    assert.equal(raum.dieses, raum);
  });
});

describe('Verdrahtung: jeder Raum wird VOR connect() abgesichert', () => {
  // Das Ereignis `AudioStreamAcquired` verdrahtet LiveKit erst in `connect()`
  // und liest `room.startAudio` genau dann — eine Absicherung danach käme zu
  // spät.
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const lies = (pfad: string) => readFileSync(join(webRoot, pfad), 'utf8');

  for (const datei of [
    'src/lib/voice/livekit.svelte.ts',
    'src/lib/anrufe/anruf.svelte.ts',
    'src/lib/gast/gastRaum.svelte.ts',
  ]) {
    test(`${datei}`, () => {
      const quelle = lies(datei);
      const neu = quelle.indexOf('const room = new Room(');
      const schutz = quelle.indexOf('startAudioAbbruchfest(room);');
      const verbinden = quelle.indexOf('await room.connect(');
      assert.ok(neu >= 0 && schutz >= 0 && verbinden >= 0, 'Marker fehlen');
      assert.ok(neu < schutz, 'Schutz steht vor dem Raum');
      assert.ok(schutz < verbinden, 'Schutz steht nach connect()');
    });
  }

  test('eigene play()-Aufrufe ohne Fänger laufen über spieleAb', () => {
    assert.match(lies('src/lib/components/message/AudioNachricht.svelte'), /void spieleAb\(audio\)/);
    assert.match(lies('src/lib/components/mobile/KameraOverlay.svelte'), /void spieleAb\(vorschau\)/);
    assert.match(lies('src/lib/voice/audioElements.ts'), /spieleAb\(anchor\)\.catch\(\(\) => onBlocked\(\)\)/);
  });
});
