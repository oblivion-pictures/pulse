import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Die Weiche zum nativen Stream-Ton (platform/iosStreamTonNativ.ts) — gegen das
// ECHTE `@capacitor/core`, mit nachgebauten Kopfzeilen der Hülle, wie
// `ios-sprache-weiche.test.ts`. Dazu die Verträge zwischen Web und Hülle, die
// kein anderer Test sieht: die Methodenliste, und dass jede Stelle, die
// LiveKits Automatik ausschaltet, den Stream-Ton mitnimmt.

type Kopf = { name: string; methods: { name: string; rtype: string | null }[] };
const g = globalThis as Record<string, unknown>;

g.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
g.Capacitor = { PluginHeaders: [] as Kopf[] };
g.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', maxTouchPoints: 5 },
  configurable: true
});

const quelle = (datei: string) =>
  readFileSync(new URL(`../../mobile/ios/App/App/${datei}`, import.meta.url), 'utf8');

function swiftMethoden(datei: string): string[] {
  return [...quelle(datei).matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((t) => t[1]);
}

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

function kopfSetzen(name: string, k: Kopf | null): void {
  const liste = (g.Capacitor as { PluginHeaders: Kopf[] }).PluginHeaders;
  const rest = liste.filter((x) => x.name !== name);
  liste.splice(0, liste.length, ...rest, ...(k ? [k] : []));
}
const streamKopfSetzen = (k: Kopf | null) => kopfSetzen('StreamTonPlugin', k);
// Der heutige Sprachweg aus der Swift-Quelle — Voraussetzung des Stream-Tons.
kopfSetzen('SprachePlugin', kopf('SprachePlugin', swiftMethoden('SprachePlugin.swift')));

test('älterer Bau ohne StreamTonPlugin: WebView-Ton', async () => {
  const { registerPlugin } = await import('@capacitor/core');
  const { streamTonNativDa } = await import('../src/lib/platform/iosStreamTonNativ.ts');
  // `registerPlugin` beim Import darf die Weiche nicht wahr machen (K1).
  registerPlugin('StreamTonPlugin');
  streamKopfSetzen(null);
  assert.equal(streamTonNativDa(), false);
});

test('Bau aus dem heutigen StreamTonPlugin.swift: nativer Ton', async () => {
  const { streamTonNativDa, STREAM_TON_METHODEN } = await import(
    '../src/lib/platform/iosStreamTonNativ.ts'
  );
  const methoden = swiftMethoden('StreamTonPlugin.swift');
  assert.ok(methoden.includes('starten'), 'Swift-Quelle nicht erkannt');
  // Jede Methode, die das Web ruft, steht in der Hülle — und umgekehrt
  // nichts, wovon das Web nichts weiss (bis auf die Hörer-Verwaltung).
  const ohneHoerer = methoden.filter((n) => n !== 'addListener' && n !== 'removeAllListeners');
  assert.deepEqual([...ohneHoerer].sort(), [...STREAM_TON_METHODEN].sort());
  streamKopfSetzen(kopf('StreamTonPlugin', methoden));
  assert.equal(streamTonNativDa(), true);
});

test('S1a: ohne nativen Sprachweg kein nativer Stream-Ton, auch mit vollem Plugin', async () => {
  const { streamTonNativDa } = await import('../src/lib/platform/iosStreamTonNativ.ts');
  streamKopfSetzen(kopf('StreamTonPlugin', swiftMethoden('StreamTonPlugin.swift')));
  assert.equal(streamTonNativDa(), true);
  // Sprache über den Web-Weg (hier: Bau ohne SprachePlugin; der Notschalter
  // `NATIVER_SPRACHWEG_AN` führt in denselben Zweig der Weiche).
  kopfSetzen('SprachePlugin', null);
  assert.equal(streamTonNativDa(), false);
  kopfSetzen('SprachePlugin', kopf('SprachePlugin', swiftMethoden('SprachePlugin.swift')));
  const src = readFileSync(new URL('../src/lib/platform/iosStreamTonNativ.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(!nativerSprachwegDa\(\)\) return false;/);
});

test('halber Kopf (eine Methode fehlt): WebView-Ton, kein halber Weg', async () => {
  const { streamTonNativDa, STREAM_TON_METHODEN } = await import(
    '../src/lib/platform/iosStreamTonNativ.ts'
  );
  streamKopfSetzen(kopf('StreamTonPlugin', STREAM_TON_METHODEN.filter((n) => n !== 'statistik')));
  assert.equal(streamTonNativDa(), false);
});

test('jede Stelle, die LiveKits Automatik ausschaltet, lässt den Stream-Ton los', () => {
  // Hält der Stream-Ton seine Session-Anforderung über eine Übergabe hinweg,
  // sieht LiveKit beim Wiederanlauf keinen Übergang „nichts aktiv → aktiv"
  // und aktiviert die Session nicht — der Heilweg des Mikrofon-Wächters und
  // die CallKit-Rückgabe liefen ins Leere (`StreamTonSitzung.swift`).
  for (const datei of ['SpracheRaumNeustart.swift', 'AnrufSitzung.swift']) {
    // Kommentarzeilen zählen nicht — dort darf die Regel in Worten stehen.
    const zeilen = quelle(datei)
      .split('\n')
      .filter((z) => !z.trimStart().startsWith('//'));
    zeilen.forEach((z, i) => {
      if (!/isAutomaticConfigurationEnabled = false/.test(z)) return;
      const danach = zeilen.slice(i + 1, i + 6).join('\n');
      assert.match(danach, /StreamTonSitzung\.geteilt\.automatikAus\(/, `${datei}:${i + 1}`);
    });
    const an = zeilen.filter((z) => /isAutomaticConfigurationEnabled = true/.test(z)).length;
    const zurueck = zeilen.filter((z) => /StreamTonSitzung\.geteilt\.automatikAn\(/.test(z)).length;
    assert.ok(zurueck >= an, `${datei}: ${an}× Automatik an, aber nur ${zurueck}× automatikAn`);
  }
});

test('der Stream-Ton hält WebKit und iosTon, aber nicht das Mikrofon', () => {
  const src = readFileSync(new URL('../src/lib/platform/iosSprache.ts', import.meta.url), 'utf8');
  assert.match(src, /'sprachkanal' \| 'anruf' \| 'vorhalt' \| 'streamton'/);
  assert.match(src, /if \(wer !== 'streamton'\) mikroHalter\.setzen\(wer, an\)/);
});

test('ausserhalb von iOS: nie nativ', async () => {
  const { streamTonNativDa } = await import('../src/lib/platform/iosStreamTonNativ.ts');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 15)', maxTouchPoints: 5 },
    configurable: true
  });
  assert.equal(streamTonNativDa(), false);
});

test('S2: die Seite räumt beim Laden ab, was eine frühere nativ gestartet hat', () => {
  const src = readFileSync(new URL('../src/lib/stream/nativerStreamTon.ts', import.meta.url), 'utf8');
  // Auf Modulebene, nicht erst in einer Kachel — sonst spielte der Ton einer
  // früheren Seite weiter, bis zufällig dieselbe Kachel wieder aufgeht.
  assert.match(src, /^void streamTonAufraeumen\(\);$/m);
  const swift = quelle('StreamTonPlugin.swift');
  assert.match(swift, /kette\.einreihen\(\{ await StreamTonVerwaltung\.geteilt\.alleStoppen\(\) \}\)/);
});

test('S3: beim Beitritt holt der Stream-Ton seine Anforderung erst nach dem Beitritt zurück', () => {
  const neustart = quelle('SpracheRaumNeustart.swift');
  assert.match(neustart, /await maschineNeu\(grund: "beitritt", streamTonZurueck: false\)/);
  assert.match(neustart, /if streamTonZurueck \{ StreamTonSitzung\.geteilt\.automatikAn/);
  const raum = quelle('SpracheRaum.swift');
  // `defer` direkt nach dem Herstellen: gilt für jeden Ausgang des Beitritts.
  assert.match(
    raum,
    /let streamTonZurueck = await sitzungFrischHerstellen\(\)[\s\S]{0,300}defer \{ if streamTonZurueck \{ StreamTonSitzung\.geteilt\.automatikAn\(grund: "beitritt"\) \} \}/
  );
});

test('S4: das Loslassen kann nicht an einem Deaktivieren scheitern', () => {
  const src = quelle('StreamTonSitzung.swift');
  const los = /private func loslassen[\s\S]*?\n    \}\n/.exec(src)?.[0] ?? '';
  assert.match(los, /isAutomaticDeactivationEnabled = false/);
  assert.ok(los.indexOf('= false') < los.indexOf('h.release()'), 'erst ausschalten, dann loslassen');
  assert.match(los, /defer \{ beobachter\.isAutomaticDeactivationEnabled = vorher \}/);
});

test('S5: CallKit-Übernahme hält die Stream-Geräte an, erst die Rückgabe lässt sie laufen', () => {
  const anruf = quelle('AnrufSitzung.swift');
  assert.match(anruf, /StreamTonSitzung\.geteilt\.automatikAus\(anruf: true\)/);
  assert.match(anruf, /StreamTonSitzung\.geteilt\.automatikAn\(grund: "callkit"\)/);
  const sitzung = quelle('StreamTonSitzung.swift');
  // Ein Beitritt oder der Wächter neben dem Anruf darf nicht freigeben.
  assert.match(sitzung, /\} else if anrufFuehrt \{[\s\S]{0,200}return/);
  assert.match(quelle('StreamTonGeraet.swift'), /if StreamTonSitzung\.geteilt\.anrufHaelt \{/);
});
