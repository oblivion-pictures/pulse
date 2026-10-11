import test from 'node:test';
import assert from 'node:assert/strict';
import {
  androidEingaben,
  androidEingabeWert,
  routenOptionen,
  routenWert
} from '../src/lib/components/settings/androidAudioWahl.ts';

const NAMEN = { hoermuschel: 'Hörmuschel', lautsprecher: 'Lautsprecher', bt: 'Bluetooth' };
const routen = [
  { id: 1, type: 'BUILTIN_SPEAKER', name: 'Speaker' },
  { id: 7, type: 'BLUETOOTH_SCO', name: 'EarFun Air' },
  { id: 9, type: 'BLE_HEADSET', name: '  ' }
];

test('routenOptionen: feste Wege plus jedes BT-Gerät, ohne Namen der Ersatzname', () => {
  assert.deepEqual(routenOptionen(null, NAMEN), []);
  assert.deepEqual(routenOptionen({ current: 'speaker', currentDeviceId: 0, devices: routen }, NAMEN), [
    { value: 'earpiece', label: 'Hörmuschel' },
    { value: 'speaker', label: 'Lautsprecher' },
    { value: 'device:7', label: 'EarFun Air' },
    { value: 'device:9', label: 'Bluetooth' }
  ]);
});

test('routenWert zeigt den aktuellen Weg', () => {
  assert.equal(routenWert(null), '');
  assert.equal(routenWert({ current: 'device', currentDeviceId: 7, devices: [] }), 'device:7');
  assert.equal(routenWert({ current: 'earpiece', currentDeviceId: 0, devices: [] }), 'earpiece');
  assert.equal(routenWert({ current: 'auto', currentDeviceId: 0, devices: [] }), 'speaker');
});

test('androidEingaben: Telefon zuerst, BT am Label oder am Produktnamen erkannt', () => {
  const eingaenge = [
    { deviceId: 'default', label: 'Standard' },
    { deviceId: 'a', label: 'Bluetooth headset' },
    { deviceId: 'b', label: 'earfun air hands-free' },
    { deviceId: 'c', label: 'Unten' }
  ];
  assert.deepEqual(androidEingaben(eingaenge, routen, 'Mikrofon'), [
    { value: 'default', label: 'Mikrofon' },
    { value: 'a', label: 'EarFun Air' },
    { value: 'b', label: 'earfun air hands-free' }
  ]);
});

test('androidEingaben: ohne "default" ist das erste Nicht-BT-Gerät das Telefon', () => {
  const eingaenge = [
    { deviceId: 'a', label: 'Bluetooth headset' },
    { deviceId: 'c', label: 'Unten' }
  ];
  assert.deepEqual(androidEingaben(eingaenge, [], 'Mikrofon'), [
    { value: 'c', label: 'Mikrofon' },
    { value: 'a', label: 'Bluetooth headset' }
  ]);
  assert.deepEqual(androidEingaben([], [], 'Mikrofon'), []);
});

test('androidEingabeWert fällt auf den ersten Eintrag zurück', () => {
  const optionen = [
    { value: 'default', label: 'Mikrofon' },
    { value: 'a', label: 'EarFun Air' }
  ];
  assert.equal(androidEingabeWert(optionen, 'a'), 'a');
  assert.equal(androidEingabeWert(optionen, 'weg'), 'default');
  assert.equal(androidEingabeWert([], 'weg'), '');
});
