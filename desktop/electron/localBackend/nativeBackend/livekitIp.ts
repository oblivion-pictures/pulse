/**
 * Öffentliche IP + LAN-IP ↔ LiveKit im nativen Windows-Weg — Gegenstück zu
 * containerIpAbgleich.ts. Hier gibt es kein Skript im Container: die
 * livekit.yaml wird neu gerendert und NUR der LiveKit-Prozess neu gestartet.
 * Begründung: oeffentlicheIp.ts.
 */

import { existsSync, writeFileSync } from 'node:fs';

import { discoverPublicIp } from '../stun.ts';
import { ermittleStandardLanIpv4 } from '../hostNetz.ts';
import { gleicheOeffentlicheIpAb, taugtAlsOeffentlicheIp, type IpAbgleichErgebnis } from '../oeffentlicheIp.ts';
import { renderLivekitYaml } from './configs.ts';
import { resolveNativeBin } from './paths.ts';
import type { SupervisedProcess } from './processes.ts';
import type { NativeSecrets } from './types.ts';

export async function oeffentlicheIpFuerStart(): Promise<string | undefined> {
  const ip = await discoverPublicIp().catch(() => null);
  return taugtAlsOeffentlicheIp(ip) ? ip : undefined;
}

/** Kennt das LiveKit-Binary `extra_node_ips`? Nur der Pulse-Fork tut es, und
 *  neben jedem seiner Binaries legt infra/livekit-fork/bauen.sh den Stempel
 *  `<binary>.fork` ab. Das offizielle livekit-server startet mit dem Feld gar
 *  nicht (strenge Konfigurationsprüfung) — ein solches kann hier liegen, wenn
 *  resources-native noch aus der Zeit vor dem Fork stammt oder ein
 *  ungepackter Lauf auf eines im PATH zurückfällt (paths.ts). Dann gibt es
 *  nur die öffentliche Adresse, wie bisher. */
export function livekitKenntExtraNodeIps(
  binaerPfad: () => string = () => resolveNativeBin('livekit-server'),
): boolean {
  try {
    return existsSync(`${binaerPfad()}.fork`);
  } catch {
    return false; // Binary fehlt — der Start scheitert ohnehin mit klarer Meldung
  }
}

/** LAN-Adresse für den Start: nur mit öffentlicher Adresse und Fork-Binary,
 *  und nicht, wenn sie die öffentliche IST (Rechner direkt am Netz) — sonst
 *  hielte der erste Abgleich den Stand für veraltet und startete neu. */
export async function lanIpFuerStart(oeffentlicheIp: string | undefined, kannLan: boolean): Promise<string | undefined> {
  if (!oeffentlicheIp || !kannLan) return undefined;
  const lan = await ermittleStandardLanIpv4().catch(() => null);
  return lan && lan !== oeffentlicheIp ? lan : undefined;
}

/** Woher der Abgleich die aktuellen Adressen nimmt — injizierbar für Tests. */
export interface AdressQuellen {
  oeffentlich(): Promise<string | null>;
  lan(): Promise<string | null>;
}

const NETZ: AdressQuellen = { oeffentlich: () => discoverPublicIp(), lan: () => ermittleStandardLanIpv4() };

export class NativeLivekitIp {
  private gesetzt: string;
  private gesetztLan: string;
  private readonly kannLan: boolean;
  private readonly yamlPfad: string;
  private readonly secrets: NativeSecrets;
  private readonly voicePort: number;
  private readonly prozess: Pick<SupervisedProcess, 'start' | 'stop'>;
  private readonly quellen: AdressQuellen;

  constructor(opts: {
    yamlPfad: string; secrets: NativeSecrets; voicePort: number;
    prozess: Pick<SupervisedProcess, 'start' | 'stop'>; gesetzt: string | undefined;
    gesetztLan: string | undefined; kannLan: boolean; quellen?: AdressQuellen;
  }) {
    this.yamlPfad = opts.yamlPfad;
    this.secrets = opts.secrets;
    this.voicePort = opts.voicePort;
    this.prozess = opts.prozess;
    this.gesetzt = opts.gesetzt ?? ''; // '' = STUN-Weg beim Start
    this.gesetztLan = opts.gesetztLan ?? '';
    this.kannLan = opts.kannLan;
    this.quellen = opts.quellen ?? NETZ;
  }

  abgleichen(): Promise<IpAbgleichErgebnis> {
    return gleicheOeffentlicheIpAb({
      ermittle: () => this.quellen.oeffentlich(),
      gesetzte: async () => this.gesetzt,
      lan: this.kannLan
        ? { ermittle: () => this.quellen.lan(), gesetzte: async () => this.gesetztLan }
        : undefined,
      setze: async (ip, lan) => {
        const neuLan = lan ?? this.gesetztLan;
        writeFileSync(
          this.yamlPfad,
          renderLivekitYaml(this.secrets, this.voicePort, ip, neuLan || undefined),
          { encoding: 'utf-8' },
        );
        await this.prozess.stop();
        await this.prozess.start();
        this.gesetzt = ip;
        this.gesetztLan = neuLan;
      },
    });
  }
}
