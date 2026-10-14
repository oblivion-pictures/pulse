/**
 * Eine Zeile, die das Übertragungsprofil eines Remote-Rechners zusammenfasst —
 * für die eingeklappte Karte im Reiter, damit man sieht, was gilt, ohne das
 * Formular zu öffnen.
 *
 * Importfrei (Nodes Testläufer); die übersetzten Teile — den Namen der Quelle
 * und das Wort für „nativ" — reicht der Aufrufer herein.
 */
interface ProfilAuszug {
  quelleName: string;
  codec: 'h264' | 'hevc' | 'av1';
  /** Wert aus dem Katalog (`Native`, `4K`, …) — `Native` wird übersetzt. */
  aufloesung: string;
  aufloesungNativ: string;
  fps: number;
  bitrate_kbps: number;
  zehn_bit: boolean;
  hdr: boolean;
}

// Dieselben Namen wie `PROFIL_CODECS` in `profilCodec.ts` — hier doppelt, weil
// die Datei importfrei bleiben muss.
const CODEC_NAME = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' } as const;

export function profilZusammenfassung(p: ProfilAuszug): string {
  const teile = [
    p.quelleName,
    CODEC_NAME[p.codec],
    p.aufloesung === 'Native' ? p.aufloesungNativ : p.aufloesung,
    `${p.fps} fps`,
    `${p.bitrate_kbps} kbit/s`,
  ];
  // Wie beim Senden: HDR nur mit AV1 (`hdrGilt` in `profilCodec.ts`), 10 bit
  // nicht mit H.264 — sonst nennt die Zeile, was nie hinausgeht.
  if (p.hdr && p.codec === 'av1') teile.push('HDR');
  else if (p.zehn_bit && p.codec !== 'h264') teile.push('10 Bit');
  return teile.join(' · ');
}
