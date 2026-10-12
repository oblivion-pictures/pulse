import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGateway, parseProcNetRoute } from '../../electron/localBackend/gateway.ts';

test('parseGateway darwin (route -n get default)', () => {
  const out = `   route to: default\ndestination: default\n       gateway: 192.168.1.1\n   interface: en0\n`;
  assert.equal(parseGateway('darwin', out), '192.168.1.1');
});

test('parseGateway linux (ip route show default)', () => {
  assert.equal(parseGateway('linux', 'default via 10.0.0.1 dev eth0 proto dhcp metric 100\n'), '10.0.0.1');
});

test('parseGateway win32 (route print)', () => {
  const out = `Network Destination        Netmask          Gateway       Interface  Metric\n          0.0.0.0          0.0.0.0      192.168.0.1     192.168.0.50     25\n`;
  assert.equal(parseGateway('win32', out), '192.168.0.1');
});

test('parseGateway: null wenn nichts passt', () => {
  assert.equal(parseGateway('linux', 'no default route here\n'), null);
});

// /proc/net/route — der Weg der Flatpak-Server-App (die Laufzeit hat kein `ip`).
const KOPF = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';

test('parseProcNetRoute: Default-Route mit kleinster Metrik, Hex rückwärts gelesen', () => {
  const text = KOPF
    + 'wlan0\t00000000\t01B2A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n'
    + 'enp5s0\t00000000\t01B2A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n'
    + 'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';
  assert.equal(parseProcNetRoute(text), '192.168.178.1');
  const zwei = KOPF
    + 'wg0\t00000000\t0100080A\t0003\t0\t0\t50\t00000000\t0\t0\t0\n'
    + 'enp5s0\t00000000\t01B2A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n';
  assert.equal(parseProcNetRoute(zwei), '10.8.0.1');
});

test('parseProcNetRoute: ohne Gateway-Flag oder ohne Default-Route → null', () => {
  assert.equal(parseProcNetRoute(KOPF + 'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n'), null);
  assert.equal(parseProcNetRoute(KOPF + 'tun0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0\n'), null);
  assert.equal(parseProcNetRoute(''), null);
});
