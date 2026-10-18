/**
 * Was die Antwort des QR-Plugins heisst — importfrei, damit der Node-Läufer
 * sie prüft (`qrScan.ts` zieht Capacitor nach).
 *
 * `kameraVerweigert` (Review V6): neuere Bauten melden `grund:
 * "kamera_verweigert"` und **zeigen den Hinweis selbst, nativ**. Die Web-App
 * darf deshalb KEINEN zweiten Toast daneben setzen — sie behandelt den Fall
 * aber nicht als stillen Abbruch, sondern führt den Nutzer zum Eintippen.
 * Ältere Bauten kennen das Feld nicht; dann bleibt es beim bisherigen
 * Verhalten (`code: null` = Abbruch).
 */
export interface QrAntwort {
  code?: string | null;
  grund?: string;
}

export interface QrErgebnis {
  code: string | null;
  kameraVerweigert: boolean;
}

export const GRUND_KAMERA_VERWEIGERT = 'kamera_verweigert';

export function qrAntwortDeuten(antwort: QrAntwort | null | undefined): QrErgebnis {
  const code = typeof antwort?.code === 'string' && antwort.code !== '' ? antwort.code : null;
  return { code, kameraVerweigert: code === null && antwort?.grund === GRUND_KAMERA_VERWEIGERT };
}
