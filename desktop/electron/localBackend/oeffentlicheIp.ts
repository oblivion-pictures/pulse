/**
 * Öffentliche IPv4 und LAN-IPv4 des Heim-Servers für LiveKit — fest
 * vorgegeben statt per STUN in LiveKit selbst, und bei einem Wechsel
 * nachgezogen.
 *
 * Warum die öffentliche fest vorgegeben (Linux-Test 2026-10-08): Mit
 * `use_external_ip` schaltet LiveKit 1.13.3 für Firefox auf „nur die
 * öffentliche Adresse" um (pkg/rtc/transport.go). Ein Firefox-Gast im selben
 * Heimnetz braucht dann Hairpin-NAT, das die Fritz!Box nicht kann — ICE
 * scheitert. Mit `node_ip` greift die Sonderbehandlung nicht.
 *
 * Warum zusätzlich die LAN-Adresse (2026-10-12, live gemessen): im
 * `node_ip`-Weg ersetzt LiveKit JEDE lokale Adresse durch diese eine —
 * `advertise_internal_ip` wirkt dort nicht. Mit der öffentlichen allein
 * brauchte damit JEDES Gerät im Heimnetz Hairpin-NAT, auch der Rechner des
 * Servers selbst („could not establish pc connection"). Die LAN-Adresse steht
 * deshalb in `extra_node_ips` daneben — eine Option, die nur der Pulse-Fork
 * von LiveKit kennt (infra/livekit-fork/). Das offizielle Binary verweigert
 * mit ihr den Start (strenge Konfigurationsprüfung) — geschrieben wird sie
 * deshalb nur dort, wo nachweislich der Fork läuft: im Container von
 * `pulse-livekit-node-ip` (dasselbe Image), nativ nur neben einem Binary mit
 * Fork-Stempel (nativeBackend/livekitIp.ts).
 *
 * Warum nachziehen: Heimanschlüsse haben keine feste IP (Zwangstrennung,
 * Router-Neustart), die LAN-Adresse kann per DHCP wechseln. LiveKit
 * ermittelte die Adresse auch mit STUN nur beim Start — nach einem Wechsel
 * kündigte es bis zum nächsten Neustart eine tote Adresse an. Der Abgleich
 * hier vergleicht beide Adressen mit den gesetzten und startet bei Abweichung
 * NUR LiveKit neu (laufende Gespräche reißen kurz ab — nach einem IP-Wechsel
 * sind sie ohnehin tot).
 *
 * Importfrei — der Node-Testläufer prüft die Entscheidung ohne Netz.
 */

/** Die vier Bytes einer nackten IPv4 (`1.2.3.4`), sonst null. */
function ipv4Teile(ip: string | null | undefined): number[] | null {
  if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return null;
  const teile = ip.split('.').map(Number);
  return teile.some((t) => t > 255) ? null : teile;
}

/** Taugt `ip` als öffentliche LiveKit-Adresse? Nackte IPv4, nicht privat,
 *  nicht Loopback/Link-local, nicht CGNAT (100.64/10 — dort hilft eine
 *  feste Adresse nichts, der Anschluss ist von außen ohnehin nicht direkt
 *  erreichbar). */
export function taugtAlsOeffentlicheIp(ip: string | null | undefined): ip is string {
  const teile = ipv4Teile(ip);
  if (!teile) return false;
  const [a, b] = teile;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/** Taugt `ip` als LAN-Adresse neben der öffentlichen? Nackte IPv4, nicht
 *  Loopback, nicht 0.x, nicht Link-local, kein Multicast. Welche Schnittstelle
 *  es ist, entscheidet hostNetz.ts::standardLanIpv4 — hier nur die Form, denn
 *  der Wert landet in einer YAML-Datei. */
export function taugtAlsLanIp(ip: string | null | undefined): ip is string {
  const teile = ipv4Teile(ip);
  if (!teile) return false;
  const [a, b] = teile;
  return !(a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254));
}

/** Welche LAN-Adresse soll LiveKit ankündigen? '' = keine.
 *  - frisch ermittelt und brauchbar: diese — ausser sie IST die öffentliche
 *    (Rechner direkt am Netz), dann reicht node_ip allein;
 *  - nicht ermittelbar (Gateway-Abfrage gescheitert): die gesetzte bleibt.
 *    Eine veraltete Zusatzadresse kostet ICE einen toten Kandidaten; sie bei
 *    jeder Störung zu entfernen und danach wieder zu setzen, kostete jedes
 *    Mal zwei LiveKit-Neustarts — mitten in laufenden Gesprächen. */
export function lanSoll(oeffentlich: string, ermittelt: string | null, gesetzt: string): string {
  if (taugtAlsLanIp(ermittelt)) return ermittelt === oeffentlich ? '' : ermittelt;
  return gesetzt === oeffentlich ? '' : gesetzt;
}

export interface IpAbgleichDeps {
  /** Aktuelle öffentliche Adresse (STUN) — null bei Fehlschlag. */
  ermittle(): Promise<string | null>;
  /** In LiveKit gesetzte Adresse — '' = keine (STUN-Weg), null = nicht lesbar. */
  gesetzte(): Promise<string | null>;
  /** Adressen setzen und LiveKit neu starten. `lan`: undefined = LAN-Teil
   *  nicht anfassen (die Gegenseite kennt ihn nicht, s. `lan` unten),
   *  '' = entfernen, sonst diese Adresse. */
  setze(ip: string, lan?: string): Promise<void>;
  /** LAN-Teil. Fehlt er, kennt die Gegenseite keine LAN-Adresse (Image älter
   *  als 2026-10-12, oder ein natives Binary ohne Fork-Stempel) — dann wird
   *  nur die öffentliche Adresse abgeglichen, wie bisher. */
  lan?: {
    /** Aktuelle LAN-Adresse — null = nicht ermittelbar. */
    ermittle(): Promise<string | null>;
    /** Gesetzte LAN-Adresse — '' = keine, null = nicht lesbar. */
    gesetzte(): Promise<string | null>;
  };
}

export type IpAbgleichErgebnis = 'gleich' | 'gesetzt' | 'unbekannt';

/** Ein Abgleichsschritt. 'unbekannt': STUN lieferte nichts Brauchbares oder
 *  ein gesetzter Stand ist nicht lesbar — dann wird NICHTS angefasst (eine
 *  Netzstörung soll LiveKit nicht neu starten). Öffentliche und LAN-Adresse
 *  ändern sich in EINEM Aufruf von `setze` — ein Neustart, nicht zwei. */
export async function gleicheOeffentlicheIpAb(deps: IpAbgleichDeps): Promise<IpAbgleichErgebnis> {
  const aktuell = await deps.ermittle().catch(() => null);
  if (!taugtAlsOeffentlicheIp(aktuell)) return 'unbekannt';
  const gesetzt = await deps.gesetzte().catch(() => null);
  if (gesetzt === null) return 'unbekannt';
  if (!deps.lan) {
    if (gesetzt === aktuell) return 'gleich';
    await deps.setze(aktuell);
    return 'gesetzt';
  }
  const lanGesetzt = await deps.lan.gesetzte().catch(() => null);
  if (lanGesetzt === null) return 'unbekannt';
  const soll = lanSoll(aktuell, await deps.lan.ermittle().catch(() => null), lanGesetzt);
  if (gesetzt === aktuell && lanGesetzt === soll) return 'gleich';
  await deps.setze(aktuell, soll);
  return 'gesetzt';
}

/** Argumente für `pulse-livekit-node-ip` im Container. `--neustart` steht
 *  bewusst an zweiter Stelle — dort liest es auch die Fassung vor dem
 *  2026-10-12, die alles ab der dritten Stelle übergeht. */
export function nodeIpSkriptArgumente(ip: string, lan?: string): string[] {
  if (lan === undefined) return [ip, '--neustart'];
  return lan ? [ip, '--neustart', '--lan', lan] : [ip, '--neustart', '--ohne-lan'];
}

/** Kennt das Image den LAN-Teil? Antwort von `pulse-livekit-node-ip
 *  --zeige-lan`: Exit 0 = ja (Ausgabe = gesetzte Adresse oder leer); Exit 2 =
 *  ein Skript von vor dem 2026-10-12, das `--zeige-lan` als ungültige IPv4
 *  abweist — dann den LAN-Teil auslassen; jeder andere Ausgang = nicht lesbar
 *  (Container weg), der Abgleich fasst dann nichts an. */
export function lanFaehigkeit(code: number): 'ja' | 'nein' | 'unlesbar' {
  if (code === 0) return 'ja';
  return code === 2 ? 'nein' : 'unlesbar';
}
