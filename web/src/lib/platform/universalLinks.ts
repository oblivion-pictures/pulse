import { App } from '@capacitor/app';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { vonAussenOeffnen } from '$lib/navigation/navigationsHerkunft';
import { isCapacitorIOS } from './runtime';
import { einladungAusDeepLink } from '$lib/einladung/deepLink';
import { einladungsZiel, istEinladungsAdresse, zielPfad } from './tiefenlink';

/**
 * Chat-Adressen von howispulse.com öffnen die App statt des Browsers.
 *
 * Die Hülle bekommt sie als `appUrlOpen`-Ereignis; welche Adressen überhaupt
 * ankommen, bestimmt Apple anhand von
 * `web/static/.well-known/apple-app-site-association` (Chat-Pfade, seit
 * 2026-10-18 auch Einladungslinks). **Auf diese Vorauswahl verlassen wir uns
 * nicht**: `zielPfad` prüft Herkunft und Pfad noch einmal selbst — das
 * Ereignis trägt auch eigene URL-Schemata, und es ist dieselbe Stelle, die
 * später ein QR-Code oder eine Share-Extension füttern würde.
 *
 * **Einladungslinks** (`/invite/<code>[?host=…]`, Eigentümer-Entscheid
 * 2026-10-18, vorher nur Chat-Pfade) öffnen die App an derselben Stelle wie
 * `pulse://invite` am Desktop: angemeldet → Einladungs-Dialog (Beitritt per
 * Klick wie auf der Webseite), sonst gemerkt und nach Anmeldung/Registrierung
 * gezeigt (`einladung/deepLink.ts`). Gast-Links und `/c/<handle>` bleiben im
 * Browser. EIN Hörer für beide Arten: ein kalt gestarteter Link wartet im
 * Plugin, bis der erste Hörer ihn abholt (`retainUntilConsumed`) — ein zweiter
 * Hörer daneben bekäme ihn nicht mehr.
 *
 * Browser, Electron und die Android-Hülle: No-op — Android hatte vor der
 * iOS-Arbeit keinen solchen Hörer und behält das (Eigentümer-Grundsatz
 * 2026-10-16). Installieren/Rückgabe wie
 * `installiereExterneLinks` — die Rückgabe ist der Aufräum-Griff für
 * `onDestroy`.
 */
export function installiereUniversalLinks(): () => void {
  if (!isCapacitorIOS()) return () => undefined;
  const griff = App.addListener('appUrlOpen', ({ url }) => {
    const einladung = einladungsZiel(url);
    if (einladung) {
      einladungAusDeepLink({ hostname: einladung.host ?? '', code: einladung.code });
      return;
    }
    // Ein Einladungslink, den der Parser ablehnt: sagen, statt zu schweigen.
    if (istEinladungsAdresse(url)) {
      toast.error(m.einladung_link_ungueltig());
      return;
    }
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
