/**
 * Darf in der iOS-Hülle gerade etwas aufgenommen werden, das das Mikrofon
 * braucht? Solange die Hülle im Sprachkanal (oder Anruf) das Mikrofon hält
 * (`mikrofonBeiDerHuelle.ts`), ist Sprachnachricht und Video-Aufnahme gesperrt:
 * ein `getUserMedia` der WebView würde die Audio-Session der Hülle
 * unterbrechen, das Mikrofon im Kanal wäre weg (Eigentümer-Entscheid
 * 2026-10-18). **Fotos bleiben möglich** — sie brauchen kein Mikrofon.
 *
 * Außerhalb der iOS-Hülle meldet niemand `mikrofonBeiDerHuelle`, die Sperre
 * trifft dort also nie zu (Desktop, Browser und Android unverändert).
 *
 * Mit `.ts`-Endung importiert, damit Nodes Läufer die Datei prüfen kann.
 */
import { mikrofonBeiDerHuelle } from './mikrofonBeiDerHuelle.ts';

export type Aufnahmeart = 'ton' | 'video' | 'foto';

export function aufnahmeGesperrt(art: Aufnahmeart): boolean {
  return art !== 'foto' && mikrofonBeiDerHuelle();
}
