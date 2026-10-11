import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Die Zahl fuer das Widget „Ungelesen“ (platform/ungelesenWidget.ts, iOS-Liste
// Punkt 45) — gegen das ECHTE `@capacitor/core`, mit nachgebauter Huelle
// (Muster: ios-sprache-weiche.test.ts). Gezaehlt wird, was der Kern an die
// Bruecke reicht: `Capacitor.nativePromise` — die Stelle, die in der echten
// Huelle das eingespielte `native-bridge.js` stellt.

type Kopf = { name: string; methods: { name: string; rtype: string | null }[] };
type Nachricht = { pluginId?: string; methodName?: string; options?: { anzahl?: number } };
const g = globalThis as Record<string, unknown>;
const gesendet: Nachricht[] = [];

g.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
g.Capacitor = {
  PluginHeaders: [] as Kopf[],
  nativePromise: (pluginId: string, methodName: string, options: Nachricht['options']) => {
    gesendet.push({ pluginId, methodName, options });
    return Promise.resolve();
  }
};
g.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', maxTouchPoints: 5 },
  configurable: true
});

function kopfSetzen(methoden: string[] | null): void {
  const liste = (g.Capacitor as { PluginHeaders: Kopf[] }).PluginHeaders;
  const neu = liste.filter((k) => k.name !== 'Ungelesen');
  if (methoden) {
    neu.push({ name: 'Ungelesen', methods: methoden.map((n) => ({ name: n, rtype: 'promise' })) });
  }
  liste.splice(0, liste.length, ...neu);
}

// Die Methoden aus der Swift-Quelle, nicht aus einer Abschrift. **Vor dem
// ersten Import gesetzt**: der Kern liest den Kopf eines Plugins einmal, in
// `registerPlugin` — in der echten Huelle steht er beim Laden der Seite schon.
const swift = readFileSync(
  new URL('../../mobile/ios/App/App/UngelesenPlugin.swift', import.meta.url),
  'utf8'
);
const SWIFT_METHODEN = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((t) => t[1]);
kopfSetzen(SWIFT_METHODEN);

const setzRufe = (): (number | undefined)[] =>
  gesendet.filter((n) => n.pluginId === 'Ungelesen').map((n) => n.options?.anzahl);
/** Der Kern ruft die Bruecke womoeglich erst nach einem `.then`. */
const abwarten = (): Promise<void> => new Promise((fertig) => setTimeout(fertig, 0));

test('aelterer Bau ohne Plugin: nichts geht an die Huelle', async () => {
  const { ungelesenAblegen } = await import('../src/lib/platform/ungelesenWidget.ts');
  kopfSetzen(null);
  ungelesenAblegen(3);
  await abwarten();
  assert.deepEqual(setzRufe(), []);
});

test('mit Plugin: Zahl geht hinueber, gleiche Zahl nur einmal, Unsinn wird 0', async () => {
  const { ungelesenAblegen } = await import('../src/lib/platform/ungelesenWidget.ts');
  assert.match(swift, /jsName = "Ungelesen"/);
  assert.ok(SWIFT_METHODEN.includes('setzen'), 'Swift-Quelle nicht erkannt');
  kopfSetzen(SWIFT_METHODEN);
  ungelesenAblegen(3);
  ungelesenAblegen(3);
  ungelesenAblegen(4.7);
  ungelesenAblegen(-2);
  ungelesenAblegen(Number.NaN);
  await abwarten();
  assert.deepEqual(setzRufe(), [3, 4, 0]);
});

test('Abmelden: 0 geht hinueber, auch wenn zuletzt schon 0 stand', async () => {
  const { ungelesenLeeren } = await import('../src/lib/platform/ungelesenWidget.ts');
  const vorher = setzRufe().length;
  ungelesenLeeren();
  await abwarten();
  assert.deepEqual(setzRufe().slice(vorher), [0]);
});

test('ausserhalb von iOS: nichts, auch mit Plugin-Kopf', async () => {
  const { ungelesenAblegen } = await import('../src/lib/platform/ungelesenWidget.ts');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 15)', maxTouchPoints: 5 },
    configurable: true
  });
  const vorher = setzRufe().length;
  ungelesenAblegen(9);
  await abwarten();
  assert.equal(setzRufe().length, vorher);
});
