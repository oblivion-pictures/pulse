/**
 * Öffentliche IP + LAN-IP ↔ LiveKit im Container (Linux) — die Brücke
 * zwischen der reinen Entscheidung (oeffentlicheIp.ts) und
 * `pulse-livekit-node-ip` im Image (infra/self-host/livekit-node-ip.sh).
 * Begründung beider Teile: dort.
 */

import { networkInterfaces } from 'node:os';

import { rtExec, type ContainerRuntime } from './containerRuntime.ts';
import { containerName } from './containerWelt.ts';
import { ermittleStandardLanIpv4, standardLanIpv4 } from './hostNetz.ts';
import { discoverPublicIp } from './stun.ts';
import {
  gleicheOeffentlicheIpAb, lanFaehigkeit, nodeIpSkriptArgumente, taugtAlsOeffentlicheIp,
  type IpAbgleichErgebnis,
} from './oeffentlicheIp.ts';

const SKRIPT = '/usr/local/bin/pulse-livekit-node-ip';

/** Für die Container-Env beim Start: die öffentliche IPv4, oder undefined
 *  (dann bleibt LiveKit im STUN-Weg wie bisher). Nur Linux — Windows (VM)
 *  kündigt die LAN-IP an, macOS ist für diesen Weg ungetestet. */
export async function oeffentlicheIpFuerStart(): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  const ip = await discoverPublicIp().catch(() => null);
  return taugtAlsOeffentlicheIp(ip) ? ip : undefined;
}

/** Für die Container-Env beim Start: die LAN-IPv4 neben der öffentlichen
 *  (PULSE_LAN_IPV4), oder undefined. Nur sinnvoll, wenn es eine öffentliche
 *  gibt — ohne sie läuft LiveKit im STUN-Weg, und der kennt keine
 *  Zusatzadresse. `gateway`: das schon ermittelte Default-Gateway des Starts.
 *  Ein Image ohne LAN-Teil ignoriert die Variable. */
export function lanIpFuerStart(oeffentlicheIp: string | undefined, gateway: string | null): string | undefined {
  if (!oeffentlicheIp) return undefined;
  return standardLanIpv4(networkInterfaces() as never, gateway) ?? undefined;
}

/** Ein Abgleich gegen den laufenden Container. 'nicht-zustaendig': nicht
 *  Linux, oder ein Image ohne das Skript (älter als 2026-10-08) — dort bleibt
 *  LiveKit beim STUN-Weg. Ein Image mit dem Skript, aber ohne LAN-Teil (älter
 *  als 2026-10-12), bekommt nur die öffentliche Adresse nachgezogen. */
export async function gleicheContainerIpAb(
  rt: ContainerRuntime,
): Promise<IpAbgleichErgebnis | 'nicht-zustaendig'> {
  if (process.platform !== 'linux') return 'nicht-zustaendig';
  const skript = (args: string[], timeoutMs = 10_000) =>
    rtExec(rt, ['exec', containerName(), SKRIPT, ...args], { timeoutMs });
  const zeige = await skript(['--zeige']);
  // 126/127 = Skript fehlt im Image; jeder andere Fehler = Container nicht da.
  if (zeige.code === 126 || zeige.code === 127) return 'nicht-zustaendig';
  const zeigeLan = zeige.code === 0 ? await skript(['--zeige-lan']) : null;
  const lan = zeigeLan ? lanFaehigkeit(zeigeLan.code) : 'unlesbar';
  return gleicheOeffentlicheIpAb({
    ermittle: () => discoverPublicIp(),
    gesetzte: async () => (zeige.code === 0 && lan !== 'unlesbar' ? zeige.stdout.trim() : null),
    lan: lan === 'ja'
      ? { ermittle: () => ermittleStandardLanIpv4(), gesetzte: async () => zeigeLan!.stdout.trim() }
      : undefined,
    setze: async (ip, lanIp) => {
      const r = await skript(nodeIpSkriptArgumente(ip, lanIp), 20_000);
      if (r.code !== 0) throw new Error(`LiveKit-Adresse nicht gesetzt (exit ${r.code}): ${r.stderr.slice(0, 200)}`);
    },
  });
}

/** Kündigt LiveKit im laufenden Container eine LAN-Adresse an? Die Adresse,
 *  oder null — keine gesetzt, ein Image ohne LAN-Teil, kein Container. Für
 *  die Diagnose (main.ts, „Sprache im Heimnetz"). */
export async function livekitLanImContainer(rt: ContainerRuntime): Promise<string | null> {
  const r = await rtExec(rt, ['exec', containerName(), SKRIPT, '--zeige-lan'], { timeoutMs: 10_000 });
  return lanFaehigkeit(r.code) === 'ja' && r.stdout.trim() ? r.stdout.trim() : null;
}
