import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

import { tonEndungen, tonWeg } from '../src/lib/sounds/tonWeg.ts';
import {
  WebAudioTon,
  type AntwortArtig,
  type KontextArtig,
  type QuelleArtig
} from '../src/lib/sounds/webAudioTon.ts';

// iOS spielt Hinweistöne über Web Audio, nie über ein Media-Element: ein
// `<audio>` legt dort die „Jetzt läuft"-Karte an und nimmt der Hülle die
// Audio-Session (Begründung in `sounds/tonWeg.ts`). Alles andere bleibt beim
// Element, wie vorher.

test('Weiche: nur iOS-WebKit nimmt Web Audio, ohne AudioContext bleibt es still', () => {
  assert.equal(tonWeg({ iosWebKit: false, audioContextDa: true }), 'element');
  assert.equal(tonWeg({ iosWebKit: false, audioContextDa: false }), 'element');
  assert.equal(tonWeg({ iosWebKit: true, audioContextDa: true }), 'webaudio');
  assert.equal(tonWeg({ iosWebKit: true, audioContextDa: false }), 'still');
});

test('Endungen: der Element-Weg bleibt bei .ogg → .mp3, iOS nimmt .m4a zuerst', () => {
  assert.deepEqual(tonEndungen('element'), ['ogg', 'mp3']);
  assert.deepEqual(tonEndungen('webaudio'), ['m4a', 'ogg']);
});

test('jede gebündelte .ogg hat ihr .m4a daneben', () => {
  const registry = readFileSync(new URL('../src/lib/sounds/registry.ts', import.meta.url), 'utf8');
  const dateien = [...registry.matchAll(/file: '([a-z-]+)'/g)].map((x) => x[1]);
  assert.ok(dateien.length >= 16);
  for (const f of dateien) {
    const ogg = new URL(`../static/sounds/${f}.ogg`, import.meta.url);
    if (!existsSync(ogg)) continue;
    assert.ok(existsSync(new URL(`../static/sounds/${f}.m4a`, import.meta.url)), `${f}.m4a fehlt`);
  }
});

test('der iOS-Weg der Engine ruft nie `new Audio`', () => {
  const engine = readFileSync(new URL('../src/lib/sounds/engine.ts', import.meta.url), 'utf8');
  const weg = /async #starteWebAudio\([\s\S]*?\n {2}\}\n/.exec(engine)?.[0];
  assert.ok(weg, '#starteWebAudio nicht gefunden');
  assert.doesNotMatch(weg, /new Audio|#start\(|#acquire/);
  // Die Verzweigung sitzt vor dem Element-Weg.
  assert.match(engine, /if \(weg === 'webaudio'\) void this\.#starteWebAudio/);
});

// --- WebAudioTon mit nachgebautem Kontext -------------------------------

class FakeQuelle implements QuelleArtig {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  gestartet = false;
  gestoppt = false;
  connect(): unknown {
    return undefined;
  }
  disconnect(): void {}
  start(): void {
    this.gestartet = true;
  }
  stop(): void {
    this.gestoppt = true;
    this.onended?.();
  }
}

class FakeKontext implements KontextArtig {
  state = 'suspended';
  destination = {};
  quellen: FakeQuelle[] = [];
  dekodiert = 0;
  weckbar = true;
  dekodierbar = true;
  async resume(): Promise<void> {
    if (this.weckbar) this.state = 'running';
  }
  async suspend(): Promise<void> {
    this.state = 'suspended';
  }
  async decodeAudioData(): Promise<{ duration: number }> {
    this.dekodiert++;
    if (!this.dekodierbar) throw new Error('EncodingError');
    return { duration: 1 };
  }
  createBufferSource(): FakeQuelle {
    const q = new FakeQuelle();
    this.quellen.push(q);
    return q;
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  }
}

function antwort(status = 200): AntwortArtig {
  return { ok: status < 400, status, arrayBuffer: async () => new ArrayBuffer(8) };
}

function aufbau(status = 200) {
  const ctx = new FakeKontext();
  const geholt: string[] = [];
  const ton = new WebAudioTon({
    neuerKontext: () => ctx,
    holen: async (u) => {
      geholt.push(u);
      return antwort(status);
    },
    ruheMs: 5,
    weckFristMs: 20
  });
  return { ctx, geholt, ton };
}

test('spielt, dekodiert je URL nur einmal und weckt den schlafenden Kontext', async () => {
  const { ctx, geholt, ton } = aufbau();
  assert.equal(await ton.spielen('/sounds/a.m4a', 0.5), 'gespielt');
  assert.equal(await ton.spielen('/sounds/a.m4a', 0.5), 'gespielt');
  assert.equal(geholt.length, 1);
  assert.equal(ctx.dekodiert, 1);
  assert.equal(ctx.quellen.length, 2);
  assert.ok(ctx.quellen.every((q) => q.gestartet));
});

test('der Kontext schläft nach dem letzten Ton wieder ein', async () => {
  const { ctx, ton } = aufbau();
  await ton.spielen('/sounds/a.m4a', 1);
  assert.equal(ctx.state, 'running');
  ctx.quellen[0].onended?.();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctx.state, 'suspended');
});

test('lässt sich der Kontext nicht wecken, bleibt der Ton aus (kein Rückfall)', async () => {
  const { ctx, ton } = aufbau();
  ctx.weckbar = false;
  assert.equal(await ton.spielen('/sounds/a.m4a', 1), 'still');
  assert.equal(ctx.quellen.length, 0);
});

test('404 heisst „fehlt", ein anderer HTTP-Fehler ist vorübergehend', async () => {
  assert.equal(await aufbau(404).ton.spielen('/x.m4a', 1), 'fehlt');
  const { ton, geholt } = aufbau(403);
  assert.equal(await ton.spielen('/x.m4a', 1), 'ladefehler');
  // Nicht zwischengespeichert: der nächste Ton versucht es neu.
  assert.equal(await ton.spielen('/x.m4a', 1), 'ladefehler');
  assert.equal(geholt.length, 2);
});

test('ein Dekodierfehler bleibt stehen, die Datei wird nicht erneut geholt', async () => {
  const { ctx, ton, geholt } = aufbau();
  ctx.dekodierbar = false;
  assert.equal(await ton.spielen('/g.ogg', 1), 'dekodierfehler');
  assert.equal(await ton.spielen('/g.ogg', 1), 'dekodierfehler');
  assert.equal(geholt.length, 1);
  ton.vergessen('/g.ogg');
  ctx.dekodierbar = true;
  assert.equal(await ton.spielen('/g.ogg', 1), 'gespielt');
});

test('höchstens drei gleichzeitige Wiedergaben derselben Datei', async () => {
  const { ctx, ton } = aufbau();
  for (let i = 0; i < 4; i++) await ton.spielen('/a.m4a', 1);
  assert.equal(ctx.quellen.length, 4);
  assert.ok(ctx.quellen[0].gestoppt);
  assert.ok(!ctx.quellen[3].gestoppt);
});

test('ohne Kontext ist alles still', async () => {
  const ton = new WebAudioTon({ neuerKontext: () => null, holen: async () => antwort() });
  assert.equal(await ton.spielen('/a.m4a', 1), 'still');
});
