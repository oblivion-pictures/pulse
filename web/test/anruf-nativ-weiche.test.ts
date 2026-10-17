import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Die Weiche zum nativen Anrufweg (platform/anrufNativWeiche.ts, Etappe 4) —
// gegen das ECHTE `@capacitor/core`, mit nachgebauten Kopfzeilen der Hülle,
// wie `ios-sprache-weiche.test.ts`.
//
// Die teuerste Antwort ist ein falsches Ja: eine Oberfläche, die gegen einen
// älteren App-Bau den nativen Anruf fährt, ruft Methoden, die die Hülle
// nicht hat — der Anruf sähe verbunden aus und wäre stumm. Deshalb kommen
// die Methoden des heutigen Baus aus den Swift-Quellen, nicht aus einer
// Abschrift.

type Kopf = { name: string; methods: { name: string; rtype: string | null }[] };
const g = globalThis as Record<string, unknown>;

g.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
g.Capacitor = { PluginHeaders: [] as Kopf[] };
g.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', maxTouchPoints: 5 },
  configurable: true
});

function kopf(name: string, methoden: string[]): Kopf {
  return {
    name,
    methods: [
      { name: 'addListener', rtype: null },
      { name: 'removeListener', rtype: null },
      ...['removeAllListeners', ...methoden].map((n) => ({ name: n, rtype: 'promise' }))
    ]
  };
}

function köpfeSetzen(...k: Kopf[]): void {
  const liste = (g.Capacitor as { PluginHeaders: Kopf[] }).PluginHeaders;
  liste.splice(0, liste.length, ...k);
}

function swiftMethoden(...dateien: string[]): string[] {
  return dateien.flatMap((datei) => {
    const quelle = readFileSync(new URL(`../../mobile/ios/App/App/${datei}`, import.meta.url), 'utf8');
    return [...quelle.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((t) => t[1]);
  });
}

const sprache = () => kopf('SprachePlugin', swiftMethoden('SprachePlugin.swift'));
const anrufHeute = () => kopf('Anruf', swiftMethoden('AnrufPlugin.swift'));

test('heutiger Bau (Sprache + Anruf aus den Swift-Quellen): nativer Anrufweg', async () => {
  const { nativerAnrufwegDa } = await import('../src/lib/platform/anrufNativWeiche.ts');
  const anruf = anrufHeute();
  assert.ok(anruf.methods.some((m) => m.name === 'raumBeitreten'), 'Swift-Quelle nicht erkannt');
  köpfeSetzen(sprache(), anruf);
  assert.equal(nativerAnrufwegDa(), true);
});

test('Bau mit dem alten Anruf-Plugin (ankommen, beenden, voipToken): kein nativer Weg', async () => {
  const { nativerAnrufwegDa } = await import('../src/lib/platform/anrufNativWeiche.ts');
  köpfeSetzen(sprache(), kopf('Anruf', ['ankommen', 'beenden', 'voipToken']));
  assert.equal(nativerAnrufwegDa(), false);
});

test('ohne nativen Sprachweg kein nativer Anruf — sie teilen sich die Session', async () => {
  const { nativerAnrufwegDa } = await import('../src/lib/platform/anrufNativWeiche.ts');
  köpfeSetzen(anrufHeute());
  assert.equal(nativerAnrufwegDa(), false);
});

test('jede Methode, die das Web ruft, steht in pluginMethods der Hülle', async () => {
  const { ANRUF_RAUM_METHODEN } = await import('../src/lib/platform/anrufNativ.ts');
  const inDerHülle = new Set(swiftMethoden('AnrufPlugin.swift'));
  const fehlen = ANRUF_RAUM_METHODEN.filter((m) => !inDerHülle.has(m));
  assert.deepEqual(fehlen, []);
});

test('E6: in der iOS-Hülle ist ein Bau ohne nativen Anrufweg „veraltet" — kein Web-Anruf', async () => {
  const { anrufwegVeraltet } = await import('../src/lib/platform/anrufNativWeiche.ts');
  // Heutiger Bau: nativ, nicht veraltet.
  köpfeSetzen(sprache(), anrufHeute());
  assert.equal(anrufwegVeraltet(), false);
  // Altes Anruf-Plugin, fehlendes Anruf-Plugin, fehlender Sprachweg: veraltet.
  köpfeSetzen(sprache(), kopf('Anruf', ['ankommen', 'beenden', 'voipToken']));
  assert.equal(anrufwegVeraltet(), true);
  köpfeSetzen(sprache());
  assert.equal(anrufwegVeraltet(), true);
  köpfeSetzen(anrufHeute());
  assert.equal(anrufwegVeraltet(), true);
});

test('E6: ausserhalb der iOS-Hülle bleibt der Web-Anruf, nie „veraltet"', async () => {
  const { anrufwegVeraltet } = await import('../src/lib/platform/anrufNativWeiche.ts');
  const vorher = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 15)', maxTouchPoints: 5 },
    configurable: true
  });
  try {
    köpfeSetzen();
    assert.equal(anrufwegVeraltet(), false);
  } finally {
    if (vorher) Object.defineProperty(globalThis, 'navigator', vorher);
  }
});

test('E6: der Anruf-Store ignoriert in der veralteten Hülle, ohne am Server abzulehnen', () => {
  const src = readFileSync(
    new URL('../src/lib/anrufe/anruf.svelte.ts', import.meta.url),
    'utf8'
  );
  const huelle = readFileSync(
    new URL('../src/lib/anrufe/anrufHuelle.ts', import.meta.url),
    'utf8'
  );
  assert.match(src, /if \(veralteteHuelleMelden\(\)\) return;/);
  // Eingehend: nur lokal ignorieren (CallKit aufräumen), KEIN Server-Ablehnen —
  // das beendete den Anruf für alle Geräte des Kontos.
  const eingehend = src.match(/if \(veralteteHuelleMelden\(evt\.call_id\)\) return;/);
  assert.ok(eingehend, 'eingehend() prüft mit der Anruf-Kennung');
  const fn = huelle.match(/export function veralteteHuelleMelden[\s\S]*?\n\}/)![0];
  assert.match(fn, /toast\.error\(m\.anruf_ios_app_veraltet\(\)\)/);
  assert.match(fn, /nativBeenden\('fehler', eingehendeId\)/);
  assert.doesNotMatch(fn, /anrufAblehnen/);
  const pruefung = src.indexOf('veralteteHuelleMelden(evt');
  assert.ok(pruefung > 0 && pruefung < src.indexOf('this.medienWaehlen()', pruefung));
  assert.ok(src.indexOf('veralteteHuelleMelden()') < src.indexOf('this.schluessel.neu('));
});
