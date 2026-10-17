/**
 * Verdrahtung von `querVollbild.ts` für eine Kachel: Lage-Ereignisse hören,
 * die Entscheidung fragen, betreten/verlassen ausführen. **Nur in der
 * iOS-Hülle** — Android, Desktop und Browser bekommen einen leeren Abbau und
 * bleiben unverändert (Android hat seinen eigenen, stillgelegten Kipp-Weg in
 * `TileShell`).
 */
import { isCapacitorIOS } from '$lib/platform/runtime';
import { QuerKacheln, istEingabe, istQuer, querVollbildAktion } from './querVollbild';

/** Eine Liste für alle Kacheln der Seite. */
export const querKacheln = new QuerKacheln();

export interface QuerVollbildZiel {
  imVollbild(): boolean;
  betreten(): void;
  verlassen(): void;
}

function jetztQuer(): boolean {
  const typ = typeof screen !== 'undefined' ? screen.orientation?.type : undefined;
  return istQuer(typ, window.matchMedia('(orientation: landscape)').matches);
}

/** Beobachten, solange die Kachel offen ist. Rückgabe baut ab. */
export function querVollbildBeobachten(id: string, ziel: QuerVollbildZiel): () => void {
  if (!isCapacitorIOS() || typeof window === 'undefined') return () => undefined;
  querKacheln.anmelden(id);
  let warQuer = jetztQuer();
  const pruefen = () => {
    const quer = jetztQuer();
    const aktion = querVollbildAktion({
      quer,
      warQuer,
      imVollbild: ziel.imVollbild(),
      ziel: querKacheln.istZiel(id),
      eingabeFokussiert: istEingabe(document.activeElement as HTMLInputElement | null)
    });
    warQuer = quer;
    if (aktion === 'betreten') ziel.betreten();
    else if (aktion === 'verlassen') ziel.verlassen();
  };
  const fenster = window.matchMedia('(orientation: landscape)');
  screen.orientation?.addEventListener('change', pruefen);
  fenster.addEventListener('change', pruefen);
  return () => {
    screen.orientation?.removeEventListener('change', pruefen);
    fenster.removeEventListener('change', pruefen);
    querKacheln.abmelden(id);
  };
}
