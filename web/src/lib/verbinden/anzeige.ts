// Was die Bestätigungsseite `/verbinden` aus einer Antwort der Cloud zeigt —
// die Teile ohne Zustand, damit die Seite unter 250 Zeilen bleibt. Die reine
// Deutung steht in `fehler.ts` (Node-getestet); hier hängen die Texte und die
// Formatierung der App dran, deshalb nicht importfrei.
import { ApiError } from '$lib/api/client';
import { formatTimestamp } from '$lib/utils/formatTimestamp';
import { m } from '$lib/paraglide/messages.js';
import { meldungsSchluessel, verbindenFehler, type VerbindenFehler } from './fehler';

/** Zeitpunkt der Cloud (ISO) so, wie ihn der Nutzer liest. */
export function datumZeigen(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return iso ?? '';
  return formatTimestamp(iso);
}

/** Deutet einen Fehlschlag der Anfrage. `frueher`: von diesem Code ging schon
 *  eine Entscheidung mit unbekanntem Ausgang hinaus. */
export function fehlerDeuten(err: unknown, frueher: boolean): VerbindenFehler {
  return err instanceof ApiError
    ? verbindenFehler(err.status, err.body, frueher)
    : verbindenFehler(null, null);
}

/** Hinweistext zu einem Fehler. `beimBestaetigen`: er gehört zu einer
 *  abgeschickten Entscheidung, nicht zum Laden. */
export function meldungstext(f: VerbindenFehler, beimBestaetigen: boolean): string {
  const schluessel = meldungsSchluessel(f, beimBestaetigen);
  const katalog = m as unknown as Record<string, (() => string) | undefined>;
  return (schluessel && katalog[schluessel]?.()) || m.verbinden_fehler_sonst();
}
