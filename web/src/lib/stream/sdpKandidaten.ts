/**
 * Welche ICE-Kandidaten bietet der Server in seiner WHEP-Antwort an?
 *
 * **Warum es das gibt.** Am 2026-10-14 kam ICE zu einem Self-Host von außen in
 * keiner Richtung zustande, von innen lief alles. Ob der Server eine falsche
 * Adresse ankündigt (Split-DNS: MediaMTX löst seinen Hostnamen im Container auf
 * und nennt die interne Adresse) oder ob eine Firewall den Port sperrt, war von
 * außen nicht zu unterscheiden — die Antwort trägt genau diese Angabe, aber
 * niemand schrieb sie auf. Sie landet jetzt als Ereignis im Zuschauer-Bericht
 * (`diagnose-bericht.ts`), den die Desktop-App ohnehin in die Cloud schickt.
 *
 * Erfasst werden die Adressen des SERVERS, nicht die des Zuschauers.
 *
 * **Importfrei**, damit `pnpm test:unit` die Datei laden kann (s. die
 * `pnpm test:unit`-Falle in `CLAUDE.md`).
 */

const MAX_KANDIDATEN = 8;

/** `udp 203.0.113.7:8189 host, …` — nur Komponente 1, ohne Doppel, gedeckelt. */
export function kandidatenAusSdp(sdp: string): string {
  const gesehen = new Set<string>();
  for (const zeile of sdp.split(/\r?\n/)) {
    if (!zeile.startsWith('a=candidate:')) continue;
    // a=candidate:<foundation> <komponente> <transport> <prio> <adresse> <port> typ <art> …
    const teile = zeile.slice('a=candidate:'.length).trim().split(/\s+/);
    if (teile.length < 8 || teile[1] !== '1' || teile[6] !== 'typ') continue;
    gesehen.add(`${teile[2].toLowerCase()} ${teile[4]}:${teile[5]} ${teile[7]}`);
  }
  if (gesehen.size === 0) return 'keine';
  const liste = [...gesehen];
  const kopf = liste.slice(0, MAX_KANDIDATEN).join(', ');
  const rest = liste.length - MAX_KANDIDATEN;
  return rest > 0 ? `${kopf} (+${rest})` : kopf;
}
