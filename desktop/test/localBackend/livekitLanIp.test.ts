// LAN-Adresse neben der öffentlichen für LiveKit (extra_node_ips, Pulse-Fork):
// Wahl der Schnittstelle, Abgleich nach DHCP-/IP-Wechsel, Container-Env,
// native livekit.yaml und der Riegel „nur neben einem Fork-Binary".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { standardLanIpv4, type IfaceTabelle } from '../../electron/localBackend/hostNetz.ts';
import {
  gleicheOeffentlicheIpAb, lanFaehigkeit, lanSoll, nodeIpSkriptArgumente, taugtAlsLanIp,
  type IpAbgleichDeps,
} from '../../electron/localBackend/oeffentlicheIp.ts';
import { renderContainerEnv } from '../../electron/localBackend/containerEnv.ts';
import { renderLivekitYaml } from '../../electron/localBackend/nativeBackend/configs.ts';
import { NativeLivekitIp, livekitKenntExtraNodeIps } from '../../electron/localBackend/nativeBackend/livekitIp.ts';

const PUB = '203.0.113.7';
const LAN = '192.168.178.20';

const v4 = (address: string, netmask = '255.255.255.0') => ({ family: 'IPv4', address, internal: false, netmask });

// ── Wahl der LAN-Adresse ─────────────────────────────────────────────────────

test('standardLanIpv4: die Schnittstelle der Standardroute, nicht die erste in der Liste', () => {
  const ifaces: IfaceTabelle = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true, netmask: '255.0.0.0' }],
    docker0: [v4('172.17.0.1', '255.255.0.0')],
    enp5s0: [v4('10.20.0.5')],
    wlan0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, v4(LAN)],
  };
  assert.equal(standardLanIpv4(ifaces, '192.168.178.1'), LAN);
  assert.equal(standardLanIpv4(ifaces, '10.20.0.1'), '10.20.0.5');
});

test('standardLanIpv4: Brücken und VPN zählen nicht, auch wenn das Gateway in ihrem Netz liegt', () => {
  const ifaces: IfaceTabelle = {
    docker0: [v4('172.17.0.1', '255.255.0.0')],
    'br-0a1b2c3d4e5f': [v4('172.18.0.1', '255.255.0.0')],
    'vEthernet (WSL)': [v4('172.29.80.1', '255.255.240.0')],
    tailscale0: [v4('100.101.102.103', '255.192.0.0')],
    wg0: [v4('10.8.0.2')],
  };
  for (const gw of ['172.17.0.254', '172.18.0.254', '172.29.80.254', '100.64.0.1', '10.8.0.1']) {
    assert.equal(standardLanIpv4(ifaces, gw), null, gw);
  }
});

test('standardLanIpv4: ohne Gateway, ohne passende Schnittstelle oder nur APIPA → null', () => {
  const ifaces: IfaceTabelle = { eth0: [v4('169.254.10.2', '255.255.0.0'), v4(LAN)] };
  assert.equal(standardLanIpv4(ifaces, null), null);
  assert.equal(standardLanIpv4(ifaces, undefined), null);
  assert.equal(standardLanIpv4(ifaces, '10.0.0.1'), null);
  assert.equal(standardLanIpv4(ifaces, '169.254.0.1'), null);
});

test('standardLanIpv4: Windows-Namen — echter Adapter ja, Default Switch und Hotspot nein', () => {
  const ifaces: IfaceTabelle = {
    'vEthernet (Default Switch)': [v4('192.168.178.200')],
    'LAN-Verbindung* 2': [v4('192.168.178.201')],
    WLAN: [v4(LAN)],
  };
  assert.equal(standardLanIpv4(ifaces, '192.168.178.1'), LAN);
});

test('taugtAlsLanIp: nur eine nackte, adressierbare IPv4', () => {
  for (const ip of [LAN, '10.0.0.5', '172.16.4.4', PUB]) assert.equal(taugtAlsLanIp(ip), true, ip);
  for (const ip of ['', null, undefined, '127.0.0.1', '0.0.0.0', '169.254.3.3', '224.0.0.1', '1.2.3', '256.1.1.1', 'fe80::1', '1.2.3.4]']) {
    assert.equal(taugtAlsLanIp(ip), false, String(ip));
  }
});

// ── Welche LAN-Adresse soll gelten? ──────────────────────────────────────────

test('lanSoll: frisch ermittelte gewinnt, gleich der öffentlichen heisst keine', () => {
  assert.equal(lanSoll(PUB, LAN, ''), LAN);
  assert.equal(lanSoll(PUB, '192.168.178.31', LAN), '192.168.178.31');
  assert.equal(lanSoll(PUB, PUB, LAN), '');
});

test('lanSoll: nicht ermittelbar → die gesetzte bleibt (kein Neustart wegen einer Störung)', () => {
  assert.equal(lanSoll(PUB, null, LAN), LAN);
  assert.equal(lanSoll(PUB, null, ''), '');
  assert.equal(lanSoll(PUB, 'kaputt', LAN), LAN);
  assert.equal(lanSoll(PUB, null, PUB), '');
});

// ── Abgleich ─────────────────────────────────────────────────────────────────

function deps(o: {
  pub: string | null; pubGesetzt: string | null;
  lan?: { ist: string | null; gesetzt: string | null };
}) {
  const aufrufe: Array<[string, string | undefined]> = [];
  const anzahlArgumente: number[] = [];
  const d: IpAbgleichDeps = {
    ermittle: async () => o.pub,
    gesetzte: async () => o.pubGesetzt,
    setze: async (...args: [string, string?]) => {
      anzahlArgumente.push(args.length);
      aufrufe.push([args[0], args[1]]);
    },
    lan: o.lan ? { ermittle: async () => o.lan!.ist, gesetzte: async () => o.lan!.gesetzt } : undefined,
  };
  return { d, aufrufe, anzahlArgumente };
}

test('Abgleich: beide Adressen unverändert → LiveKit bleibt in Ruhe', async () => {
  const { d, aufrufe } = deps({ pub: PUB, pubGesetzt: PUB, lan: { ist: LAN, gesetzt: LAN } });
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gleich');
  assert.deepEqual(aufrufe, []);
});

test('Abgleich: neue LAN-Adresse (DHCP) → beide in EINEM Aufruf gesetzt', async () => {
  const { d, aufrufe } = deps({ pub: PUB, pubGesetzt: PUB, lan: { ist: '192.168.178.31', gesetzt: LAN } });
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gesetzt');
  assert.deepEqual(aufrufe, [[PUB, '192.168.178.31']]);
});

test('Abgleich: neue öffentliche Adresse → LAN-Adresse wird mitgegeben, nicht verloren', async () => {
  const { d, aufrufe } = deps({ pub: '198.51.100.9', pubGesetzt: PUB, lan: { ist: LAN, gesetzt: LAN } });
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gesetzt');
  assert.deepEqual(aufrufe, [['198.51.100.9', LAN]]);
});

test('Abgleich: Container noch im STUN-Weg → öffentliche und LAN-Adresse zugleich', async () => {
  const { d, aufrufe } = deps({ pub: PUB, pubGesetzt: '', lan: { ist: LAN, gesetzt: '' } });
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gesetzt');
  assert.deepEqual(aufrufe, [[PUB, LAN]]);
});

test('Abgleich: LAN-Adresse nicht ermittelbar → nichts anfassen', async () => {
  const { d, aufrufe } = deps({ pub: PUB, pubGesetzt: PUB, lan: { ist: null, gesetzt: LAN } });
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gleich');
  assert.deepEqual(aufrufe, []);
});

test('Abgleich: Rechner jetzt direkt am Netz (LAN = öffentlich) → Zusatzadresse entfernen', async () => {
  const { d, aufrufe } = deps({ pub: PUB, pubGesetzt: PUB, lan: { ist: PUB, gesetzt: LAN } });
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gesetzt');
  assert.deepEqual(aufrufe, [[PUB, '']]);
});

test('Abgleich: gesetzte LAN-Adresse nicht lesbar → unbekannt, nichts anfassen', async () => {
  const { d, aufrufe } = deps({ pub: PUB, pubGesetzt: '198.51.100.9', lan: { ist: LAN, gesetzt: null } });
  assert.equal(await gleicheOeffentlicheIpAb(d), 'unbekannt');
  assert.deepEqual(aufrufe, []);
});

test('Abgleich ohne LAN-Teil (älteres Image): nur die öffentliche, ohne zweites Argument', async () => {
  const { d, aufrufe, anzahlArgumente } = deps({ pub: '198.51.100.9', pubGesetzt: PUB });
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gesetzt');
  assert.deepEqual(aufrufe, [['198.51.100.9', undefined]]);
  assert.deepEqual(anzahlArgumente, [1]);
});

// ── Container: Skript-Aufruf und Fähigkeit ───────────────────────────────────

test('nodeIpSkriptArgumente: --neustart an zweiter Stelle, LAN-Angabe dahinter', () => {
  assert.deepEqual(nodeIpSkriptArgumente(PUB), [PUB, '--neustart']);
  assert.deepEqual(nodeIpSkriptArgumente(PUB, LAN), [PUB, '--neustart', '--lan', LAN]);
  assert.deepEqual(nodeIpSkriptArgumente(PUB, ''), [PUB, '--neustart', '--ohne-lan']);
});

test('lanFaehigkeit: 0 = kennt LAN, 2 = Skript von vor dem 2026-10-12, sonst unlesbar', () => {
  assert.equal(lanFaehigkeit(0), 'ja');
  assert.equal(lanFaehigkeit(2), 'nein');
  for (const code of [1, 3, 125, 126, 127, 137]) assert.equal(lanFaehigkeit(code), 'unlesbar', String(code));
});

const CREDS = {
  instanceId: '42', ownerId: '7', clientId: 'cid', clientSecret: 'geheim',
  cloudOrigin: 'https://howispulse.com', hostname: 'app-42.relay.example.com',
  relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null,
} as never;

test('renderContainerEnv: PULSE_LAN_IPV4 nur neben PULSE_PUBLIC_IPV4 und nur, wenn verschieden', () => {
  const mit = renderContainerEnv(CREDS, undefined, [], undefined, true, PUB, LAN);
  assert.match(mit, new RegExp(`^PULSE_PUBLIC_IPV4=${PUB}$`, 'm'));
  assert.match(mit, new RegExp(`^PULSE_LAN_IPV4=${LAN}$`, 'm'));
  // Ohne öffentliche Adresse läuft LiveKit im STUN-Weg, der keine Zusatzadresse kennt.
  assert.doesNotMatch(renderContainerEnv(CREDS, undefined, [], undefined, true, undefined, LAN), /PULSE_LAN_IPV4/);
  assert.doesNotMatch(renderContainerEnv(CREDS, undefined, [], undefined, true, PUB, PUB), /PULSE_LAN_IPV4/);
  // Bestandsaufruf ohne siebtes Argument: unverändert.
  assert.doesNotMatch(renderContainerEnv(CREDS, undefined, [], undefined, true, PUB), /PULSE_LAN_IPV4/);
});

// ── Nativ (Windows): livekit.yaml und Fork-Riegel ────────────────────────────

const SECRETS = { livekitApiKey: 'k', livekitApiSecret: 's' } as never;

test('renderLivekitYaml: LAN-Adresse als extra_node_ips direkt nach node_ip', () => {
  const yaml = renderLivekitYaml(SECRETS, 8003, PUB, LAN);
  assert.match(yaml, new RegExp(`  use_external_ip: false\\n  node_ip: ${PUB}\\n  extra_node_ips: \\[${LAN}\\]\\n`));
});

test('renderLivekitYaml: keine Zusatzadresse im STUN-Weg, ohne LAN oder bei LAN = öffentlich', () => {
  const stun = renderLivekitYaml(SECRETS, 8003, undefined, LAN);
  assert.match(stun, /use_external_ip: true/);
  for (const yaml of [stun, renderLivekitYaml(SECRETS, 8003, PUB), renderLivekitYaml(SECRETS, 8003, PUB, PUB)]) {
    assert.doesNotMatch(yaml, /extra_node_ips/);
  }
});

test('livekitKenntExtraNodeIps: nur mit Fork-Stempel neben dem Binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-lk-stempel-'));
  const exe = join(dir, 'livekit-server.exe');
  writeFileSync(exe, '');
  assert.equal(livekitKenntExtraNodeIps(() => exe), false);
  writeFileSync(`${exe}.fork`, '1.13.3-pulse1 livekit=… mediatransportutil=…\n');
  assert.equal(livekitKenntExtraNodeIps(() => exe), true);
  assert.equal(livekitKenntExtraNodeIps(() => { throw new Error('Binary fehlt'); }), false);
});

function nativerAbgleich(o: { kannLan: boolean; pub: string; lan: string | null; gesetztLan?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-lk-nativ-'));
  const yamlPfad = join(dir, 'livekit.yaml');
  const neustarts: string[] = [];
  const lk = new NativeLivekitIp({
    yamlPfad, secrets: SECRETS, voicePort: 8003, gesetzt: PUB, gesetztLan: o.gesetztLan, kannLan: o.kannLan,
    prozess: { stop: async () => { neustarts.push('stop'); }, start: async () => { neustarts.push('start'); } },
    quellen: { oeffentlich: async () => o.pub, lan: async () => o.lan },
  });
  return { lk, yamlPfad, neustarts };
}

test('NativeLivekitIp: LAN-Wechsel → livekit.yaml neu, ein Neustart, danach Ruhe', async () => {
  const { lk, yamlPfad, neustarts } = nativerAbgleich({ kannLan: true, pub: PUB, lan: '192.168.178.31', gesetztLan: LAN });
  assert.equal(await lk.abgleichen(), 'gesetzt');
  assert.match(readFileSync(yamlPfad, 'utf8'), /node_ip: 203\.0\.113\.7\n  extra_node_ips: \[192\.168\.178\.31\]/);
  assert.deepEqual(neustarts, ['stop', 'start']);
  assert.equal(await lk.abgleichen(), 'gleich');
  assert.deepEqual(neustarts, ['stop', 'start']);
});

test('NativeLivekitIp: ohne Fork-Binary nie extra_node_ips, auch wenn eine LAN-Adresse da ist', async () => {
  const { lk, yamlPfad, neustarts } = nativerAbgleich({ kannLan: false, pub: '198.51.100.9', lan: LAN });
  assert.equal(await lk.abgleichen(), 'gesetzt');
  const yaml = readFileSync(yamlPfad, 'utf8');
  assert.match(yaml, /node_ip: 198\.51\.100\.9\n/);
  assert.doesNotMatch(yaml, /extra_node_ips/);
  assert.deepEqual(neustarts, ['stop', 'start']);
});
