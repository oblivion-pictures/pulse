import { App } from '@capacitor/app';
import { vonAussenOeffnen } from '$lib/navigation/navigationsHerkunft';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';
import { zielPfad } from './tiefenlink';

/**
 * Chat-Adressen von howispulse.com öffnen die App statt des Browsers.
 *
 * Die Hülle bekommt sie als `appUrlOpen`-Ereignis; welche Adressen überhaupt
 * ankommen, bestimmt Apple anhand von
 * `web/static/.well-known/apple-app-site-association` (nur Chat-Pfade,
 * Eigentümer-Entscheid 2026-10-08). **Auf diese Vorauswahl verlassen wir uns
 * nicht**: `zielPfad` prüft Herkunft und Pfad noch einmal selbst — das
 * Ereignis trägt auch eigene URL-Schemata, und es ist dieselbe Stelle, die
 * später ein QR-Code oder eine Share-Extension füttern würde.
 *
 * Browser und Electron: No-op. Installieren/Rückgabe wie
 * `installiereExterneLinks` — die Rückgabe ist der Aufräum-Griff für
 * `onDestroy`.
 */
export function installiereUniversalLinks(): () => void {
  if (!isCapacitorIOS() && !isCapacitorAndroid()) return () => undefined;
  const griff = App.addListener('appUrlOpen', ({ url }) => {
    const ziel = zielPfad(url);
    // Kein erkanntes Ziel: NICHTS tun. Die App ist durch das Ereignis ohnehin
    // schon im Vordergrund; irgendwohin zu springen wäre schlechter als da zu
    // bleiben, wo der Nutzer war.
    if (!ziel) return;
    // **Von aussen**: ein Link auf einen Sprachkanal öffnet die Seite, tritt
    // aber nicht bei — bis zum 2026-10-11 trat er ungefragt bei, mit offenem
    // Mikrofon (Bughunt 2, D1; Regel in `navigation/herkunft.ts`).
    void vonAussenOeffnen(ziel);
  });
  return () => {
    void griff.then((h) => h.remove()).catch(() => undefined);
  };
}
