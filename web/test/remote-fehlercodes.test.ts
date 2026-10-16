import { test } from 'node:test';
import assert from 'node:assert/strict';
import { istAnfrageFehler, weckFehlerArt } from '../src/lib/remote/fehlerCodes.ts';
import { WS_FEHLER } from '../src/lib/api/constants.ts';

test('Anfrage-Fehler: 4050–4059 und 4062, sonst nichts', () => {
  for (let c = 4050; c <= 4059; c++) assert.equal(istAnfrageFehler(c), true, String(c));
  assert.equal(istAnfrageFehler(WS_FEHLER.GERAET_NICHT_FREIGEGEBEN), true);
  // Weck-Fehler, die keine Anfrage betreffen, brechen keine Anfrage ab.
  assert.equal(istAnfrageFehler(WS_FEHLER.GERAET_UNBEKANNT), false);
  assert.equal(istAnfrageFehler(WS_FEHLER.GERAET_OFFLINE), false);
  assert.equal(istAnfrageFehler(4049), false);
  assert.equal(istAnfrageFehler(4071), false);
});

test('Weck-Fehler: 4060 und 4062 heißen „nicht freigegeben", 4061 offline, 4056 zu schnell', () => {
  assert.equal(weckFehlerArt(4060), 'nicht_freigegeben');
  assert.equal(weckFehlerArt(4062), 'nicht_freigegeben');
  assert.equal(weckFehlerArt(4061), 'offline');
  assert.equal(weckFehlerArt(4056), 'zu_schnell');
});

test('fremde Fehler gehören nicht zum Wecken', () => {
  for (const c of [4050, 4051, 4052, 4053, 4054, 4055, 4063, 1000]) {
    assert.equal(weckFehlerArt(c), null, String(c));
  }
});

test('die Codes stimmen mit WS_FEHLER überein (Gegenstück routes/ws_device_handlers.py)', () => {
  assert.deepEqual(WS_FEHLER, {
    GERAET_UNBEKANNT: 4060,
    GERAET_OFFLINE: 4061,
    GERAET_NICHT_FREIGEGEBEN: 4062,
  });
});
