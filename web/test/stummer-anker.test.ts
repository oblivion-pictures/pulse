/**
 * Der stumme Anker des Web-Audio-Wegs (`audio/stummerAnker.ts`).
 *
 * LiveKits `room.startAudio()` setzt `muted = false` für jedes per
 * `track.attach()` angehängte Element — ein von Pulse stumm gehaltener Anker
 * war danach hörbar, der Ton lief doppelt (Element plus Web-Audio-Zug). Die
 * Lösung ist ein EIGENES Element, das LiveKit nicht kennt. Hier die kleine
 * Rechnung dahinter und die Verdrahtung an den zwei Stellen, die den Anker
 * brauchen. Der Browser-Nachweis mit der echten Bibliothek, der echten Kachel
 * und dem echten Gast-Modul steht in `tests/e2e/doppelter-ton.spec.ts` —
 * Playwright hängt aber in keinem Gate, deshalb steht die Verdrahtung auch hier.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ankerBefestigen, ankerLoesen } from '../src/lib/audio/stummerAnker.ts';

/** Ein Element, das jeden Zugriff in der Reihenfolge mitschreibt. */
function nachbau(play: () => Promise<void> = () => Promise.resolve()) {
  const protokoll: string[] = [];
  const el = {
    set muted(v: boolean) {
      protokoll.push(`muted=${v}`);
    },
    set autoplay(v: boolean) {
      protokoll.push(`autoplay=${v}`);
    },
    set srcObject(v: MediaStream | null) {
      protokoll.push(`srcObject=${v === null ? 'null' : 'strom'}`);
    },
    play() {
      protokoll.push('play');
      return play();
    },
    pause() {
      protokoll.push('pause');
    },
  };
  return { el, protokoll };
}

const strom = {} as MediaStream;

describe('ankerBefestigen', () => {
  test('stumm VOR dem Strom, dann abspielen', () => {
    const { el, protokoll } = nachbau();
    ankerBefestigen(el as never, strom);
    // Wäre der Strom zuerst da, gäbe es einen hörbaren Augenblick.
    assert.ok(protokoll.indexOf('muted=true') < protokoll.indexOf('srcObject=strom'));
    assert.ok(protokoll.indexOf('srcObject=strom') < protokoll.indexOf('play'));
    assert.ok(!protokoll.includes('muted=false'));
  });

  test('ein abgelehntes play() bleibt folgenlos (kein unbehandeltes Promise)', async () => {
    const unbehandelt: unknown[] = [];
    const merke = (e: unknown) => unbehandelt.push(e);
    process.on('unhandledRejection', merke);
    try {
      for (const name of ['AbortError', 'NotAllowedError']) {
        const { el } = nachbau(() => Promise.reject(new DOMException('x', name)));
        ankerBefestigen(el as never, strom);
      }
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', merke);
    }
    assert.deepEqual(unbehandelt, []);
  });
});

describe('ankerLoesen', () => {
  test('anhalten und vom Strom trennen, das Element nicht entstummen', () => {
    const { el, protokoll } = nachbau();
    ankerLoesen(el as never);
    assert.deepEqual(protokoll, ['pause', 'srcObject=null']);
  });
});

describe('Verdrahtung: wo der Web-Audio-Zug den Ton trägt, hängt der Anker NICHT an LiveKit', () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  // Ohne Kommentare: die erklären den alten Weg und nennen `track.attach()`.
  const lies = (pfad: string) =>
    readFileSync(join(webRoot, pfad), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('Gast (Desktop): eigenes Element, kein track.attach() im Zug', () => {
    const quelle = lies('src/lib/gast/gastTon.ts');
    assert.ok(/ankerBefestigen\(anker, strom\)/.test(quelle), 'der Desktop-Zweig nutzt den Anker');
    // `attach()` kommt genau einmal vor: der Mobil-Zweig, wo das Element selbst
    // hörbar ist. Ein zweites wäre der alte Fehler zurück.
    assert.equal(quelle.match(/track\.attach\(\)/g)?.length, 1);
    assert.ok(
      quelle.indexOf('track.attach()') < quelle.indexOf('ankerBefestigen('),
      'das einzige attach() steht im Mobil-Zweig, vor dem Desktop-Anker'
    );
  });

  test('Bildschirmfreigabe-Kachel: Anker beim Zug, attach() nur im Rückfall', () => {
    const quelle = lies('src/lib/components/ScreenShareTile.svelte');
    assert.ok(/ankerBefestigen\(el, strom\)/.test(quelle), 'der Zug nutzt den Anker');
    // Das Audio-`attach()` steht im Rückfall (Zug nicht zustande gekommen), nie
    // davor. Das Video-`attach()` (`t.attach(el)`) ist ein anderes Ding.
    assert.equal(quelle.match(/\bat\.attach\(el\)/g)?.length, 1);
    assert.ok(quelle.indexOf('ankerBefestigen(el, strom)') < quelle.indexOf('at.attach(el)'));
    assert.ok(!/el\.muted = boosted/.test(quelle), 'der alte Weg: attach(), dann stumm schalten');
  });
});
