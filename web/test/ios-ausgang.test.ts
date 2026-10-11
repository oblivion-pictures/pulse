import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { iosAusgang } from '../src/lib/platform/iosAusgang.ts';

// Welcher Ausgang auf iOS spielt (platform/iosAusgang.ts). Bis zum 2026-10-11
// galt jeder fremde Ausgang als Bluetooth — auch Kabel, AirPlay und das Auto —,
// und ein leerer Porttyp (mitten in einem Wechsel) ebenso.

test('Lautsprecher und Hörmuschel sind die beiden festen Wege', () => {
  assert.deepEqual(iosAusgang('Speaker'), { wahl: 'speaker' });
  assert.deepEqual(iosAusgang('Receiver'), { wahl: 'earpiece' });
});

test('fremde Ausgänge tragen ihre Art (Rohwerte von AVAudioSession.Port)', () => {
  const art = (p: string) => {
    const a = iosAusgang(p);
    return a.wahl === 'device' ? a.art : a.wahl;
  };
  assert.equal(art('BluetoothHFP'), 'funk');
  assert.equal(art('BluetoothA2DPOutput'), 'funk');
  assert.equal(art('BluetoothLE'), 'funk');
  assert.equal(art('Headphones'), 'kabel');
  assert.equal(art('USBAudio'), 'kabel');
  assert.equal(art('HDMIOutput'), 'kabel');
  assert.equal(art('AirPlay'), 'airplay');
  assert.equal(art('CarAudio'), 'auto');
});

test('ein unbekannter Port ist ein Gerät, aber kein Bluetooth', () => {
  assert.deepEqual(iosAusgang('Virtual'), { wahl: 'device', art: 'sonst' });
});

test('kein Ausgang bekannt ist kein Gerät', () => {
  assert.deepEqual(iosAusgang(''), { wahl: 'auto' });
});
