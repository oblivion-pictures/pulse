/**
 * Öffentliche IP + LAN-IP ↔ LiveKit im Container (Linux) — die Brücke
 * zwischen der reinen Entscheidung (oeffentlicheIp.ts) und
 * `pulse-livekit-node-ip` im Image (infra/self-host/livekit-node-ip.sh).
 * Begründung beider Teile: dort.
 */

import { networkInterfaces } from 'node:os';

import { rtExec, type ContainerRuntime, type ExecResult } from './containerRuntime.ts';
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

/** `pulse-livekit-node-ip` im laufenden Container aufrufen. */
function nodeIpSkript(rt: ContainerRuntime, args: string[], timeoutMs = 10_000): Promise<ExecResult> {
  return rtExec(rt, ['exec', containerName(), SKRIPT, ...args], { timeoutMs });
}

/** Ein Abgleich gegen den laufenden Container. 'nicht-zustaendig': nicht
 *  Linux, oder ein Image ohne das Skript (älter als 2026-10-08) — dort bleibt
 *  LiveKit beim STUN-Weg. Ein Image mit dem Skript, aber ohne LAN-Teil (älter
 *  als 2026-10-12), bekommt nur die öffentliche Adresse nachgezogen. */
export async function gleicheContainerIpAb(
  rt: ContainerRuntime,
): Promise<IpAbgleichErgebnis | 'nicht-zustaendig'> {
  if (process.platform !== 'linux') return 'nicht-zustaendig';
  const zeige = await nodeIpSkript(rt, ['--zeige']);
  // 126/127 = Skript fehlt im Image; jeder andere Fehler = Container nicht da.
  if (zeige.code === 126 || zeige.code === 127) return 'nicht-zustaendig';
  // Ohne lesbare node_ip (zeige.code !== 0) gibt es auch keinen LAN-Stand zu lesen.
  const zeigeLan = zeige.code === 0 ? await nodeIpSkript(rt, ['--zeige-lan']) : null;
  const lanFaehig = zeigeLan ? lanFaehigkeit(zeigeLan.code) : 'unlesbar';
  return gleicheOeffentlicheIpAb({
    ermittle: () => discoverPublicIp(),
    gesetzte: async () => (lanFaehig === 'unlesbar' ? null : zeige.stdout.trim()),
    lan: zeigeLan && lanFaehig === 'ja'
      ? { ermittle: () => ermittleStandardLanIpv4(), gesetzte: async () => zeigeLan.stdout.trim() }
      : undefined,
    setze: async (ip, lanIp) => {
      const r = await nodeIpSkript(rt, nodeIpSkriptArgumente(ip, lanIp), 20_000);
      if (r.code !== 0) throw new Error(`LiveKit-Adresse nicht gesetzt (exit ${r.code}): ${r.stderr.slice(0, 200)}`);
    },
  });
}

/** Kündigt LiveKit im laufenden Container eine LAN-Adresse an? Die Adresse,
 *  oder null — keine gesetzt, ein Image ohne LAN-Teil, kein Container. Für
 *  die Diagnose (main.ts, „Sprache im Heimnetz"). */
export async function livekitLanImContainer(rt: ContainerRuntime): Promise<string | null> {
  const r = await nodeIpSkript(rt, ['--zeige-lan']);
  const adresse = r.stdout.trim();
  return lanFaehigkeit(r.code) === 'ja' && adresse ? adresse : null;
}
