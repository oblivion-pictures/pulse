/**
 * Anzeigecode der Server-Verbindung (`XXXX-XXXX`, Crockford-Base32) — reine
 * Rechnung, importfrei (Node-Unit-Test, s. `pnpm test:unit`-Falle in
 * CLAUDE.md).
 *
 * Dieselbe Normalisierung wie `dcc_auth/verbinden.py::code_normalisieren`
 * (Etappe 1): Groß/klein egal, Leerraum und Bindestriche egal, `O`→`0`,
 * `I`/`L`→`1`. Die Cloud normalisiert selbst noch einmal; hier geht es darum,
 * einen Tippfehler sofort zu melden, statt die Bremse am Server
 * (20 Bestätigungen je Stunde und Konto) zu verbrauchen.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LAENGE = 8;
/** Mehr tippt niemand für acht Zeichen; längere Eingaben sind kein Code. */
const MAX_ROH = 32;

export function codeNormalisieren(roh: string): string | null {
  if (roh.length > MAX_ROH) return null;
  const s = roh
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== LAENGE) return null;
  for (const zeichen of s) {
    if (!ALPHABET.includes(zeichen)) return null;
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Code aus `location.hash` (mit oder ohne führendes `#`). Kaputt kodierte
 *  Adressen (`%E0%A4%A`) sind kein Code, kein Absturz. */
export function codeAusHash(hash: string): string | null {
  const roh = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!roh) return null;
  let dekodiert: string;
  try {
    dekodiert = decodeURIComponent(roh);
  } catch {
    return null;
  }
  return codeNormalisieren(dekodiert);
}
