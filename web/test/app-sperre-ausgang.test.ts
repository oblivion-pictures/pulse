import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sperreAusgang } from '../src/lib/platform/appSperreAusgang.ts';

/**
 * iOS-Review B1 — die App-Sperre hat einen Ausweg, wenn am Gerät kein Code
 * mehr gesetzt ist. Die Rechnung ist importfrei, weil `appSperre.svelte.ts`
 * Runen auf Modulebene hat.
 */

const gibtCode = async () => true;
const keinCode = async () => false;
const wirft = async (): Promise<boolean> => {
  throw new Error('Plugin weg');
};

test('ok heisst entsperrt, ohne das Plugin nochmals zu fragen', async () => {
  let gefragt = false;
  const a = await sperreAusgang({ ok: true }, async () => ((gefragt = true), true));
  assert.equal(a, 'entsperrt');
  assert.equal(gefragt, false);
});

test('ein Abbruch bleibt ein Abbruch, auch wenn das Gerät nichts mehr prüfen könnte', async () => {
  assert.equal(await sperreAusgang({ ok: false, abgebrochen: true }, keinCode), 'abgebrochen');
});

test('neuer Bau: grund kein_code wird erkannt (die Sperre bleibt, s. Verdrahtungstest)', async () => {
  assert.equal(await sperreAusgang({ ok: false, grund: 'kein_code' }, gibtCode), 'kein_code');
});

test('alter Bau: nur ok:false, aber das Gerät kann nicht mehr prüfen -> kein_code', async () => {
  assert.equal(
    await sperreAusgang({ ok: false, abgebrochen: false, grund: 'Passcode not set' }, keinCode),
    'kein_code',
  );
  assert.equal(await sperreAusgang({ ok: false }, keinCode), 'kein_code');
});

test('Gerät kann prüfen, Versuch scheiterte (Face ID falsch) -> Fehler, Sperre bleibt', async () => {
  assert.equal(await sperreAusgang({ ok: false, abgebrochen: false, grund: 'x' }, gibtCode), 'fehler');
});

test('scheitert die Rückfrage selbst, wird nie aus Unsicherheit aufgeschlossen', async () => {
  assert.equal(await sperreAusgang({ ok: false, abgebrochen: false }, wirft), 'fehler');
});
