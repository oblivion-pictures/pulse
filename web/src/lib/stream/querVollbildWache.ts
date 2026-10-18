/**
 * Verdrahtung von `querVollbild.ts` für eine Kachel: Lage-Ereignisse hören,
 * die Entscheidung fragen, betreten/verlassen ausführen. **In beiden
 * Mobil-Hüllen** (iOS kam zuerst, Android nach Nutzerwunsch am 2026-10-19);
 * Desktop und Browser bekommen einen leeren Abbau und bleiben unverändert —
 * auf dem Desktop würde jede Fenstergrößen-Änderung über die Quer-Schwelle
 * sonst ins Vollbild kippen.
 */
import { isCapacitorAndroid, isCapacitorIOS } from '$lib/platform/runtime';
import { aufVollbildWechsel, vollbildElement, vollbildVerlassen } from './fullscreen';
import { QuerKacheln, QuerVerlauf, istEingabe, istQuer } from './querVollbild';

/** Eine Liste für alle Kacheln der Seite. */
export const querKacheln = new QuerKacheln();

/**
 * Die zwei Vollbild-Quellen einer Kachel (`TileShell`). Betreten wird immer
 * das SELBST GEBAUTE: die Hülle hat zwar `requestFullscreen` (Capacitor
 * schaltet Element-Vollbild ein), das verlangt aber eine Geste, und Drehen ist
 * keine. Über den Vollbild-KNOPF kommt man dort aber ins ECHTE.
 */
export interface QuerVollbildKachel {
  /** Selbst gebautes Vollbild an/aus (beim Anschalten samt Handgriffen). */
  eigenes(an: boolean): void;
  imEigenen(): boolean;
  /** Den gemerkten Stand des echten Vollbilds überschreiben. */
  echt(an: boolean): void;
}

/**
 * Das echte Vollbild wird bei jeder Frage frisch aus dem Dokument gelesen
 * (und der gemerkte Stand der Kachel mitgezogen), beim Verlassen werden beide
 * Quellen hart zurückgesetzt: ein hängen gebliebener Stand nach dem
 * Knopf-Vollbild hielte die Kachel sonst für „schon im Vollbild" und
 * blockierte das nächste Quer-Vollbild.
 */
function zielFuer(k: QuerVollbildKachel) {
  const echtLesen = () => {
    const an = !!vollbildElement();
    k.echt(an);
    return an;
  };
  return {
    imVollbild: () => echtLesen() || k.imEigenen(),
    betreten: () => k.eigenes(true),
    verlassen: () => {
      k.eigenes(false);
      k.echt(false);
      void vollbildVerlassen().then(echtLesen);
    }
  };
}

export function jetztQuer(): boolean {
  const s = typeof screen !== 'undefined' ? screen : undefined;
  return istQuer({
    breite: document.documentElement.clientWidth || window.innerWidth,
    kurzeSeite: s ? Math.min(s.width, s.height) : 0,
    typ: s?.orientation?.type,
    fensterQuer: window.matchMedia('(orientation: landscape)').matches
  });
}

/** Beobachten, solange die Kachel offen ist. Rückgabe baut ab. */
export function querVollbildBeobachten(id: string, kachel: QuerVollbildKachel): () => void {
  if ((!isCapacitorIOS() && !isCapacitorAndroid()) || typeof window === 'undefined') {
    return () => undefined;
  }
  const ziel = zielFuer(kachel);
  querKacheln.anmelden(id);
  const verlauf = new QuerVerlauf(jetztQuer());
  const pruefen = () => {
    const aktion = verlauf.schritt({
      quer: jetztQuer(),
      imVollbild: ziel.imVollbild(),
      ziel: querKacheln.istZiel(id),
      eingabeFokussiert: istEingabe(document.activeElement as HTMLInputElement | null)
    });
    if (aktion === 'betreten') ziel.betreten();
    else if (aktion === 'verlassen') ziel.verlassen();
  };
  // Drei Quellen für denselben Wechsel: welche zuerst kommt und ob die Masse
  // dann schon stehen, ist nicht festgelegt. `schritt` handelt nur beim
  // Übergang, ein doppeltes Ereignis tut deshalb nichts.
  const fenster = window.matchMedia('(orientation: landscape)');
  screen.orientation?.addEventListener('change', pruefen);
  fenster.addEventListener('change', pruefen);
  window.addEventListener('resize', pruefen);
  const abVollbild = aufVollbildWechsel(() => verlauf.abgleichen(jetztQuer()));
  return () => {
    screen.orientation?.removeEventListener('change', pruefen);
    fenster.removeEventListener('change', pruefen);
    window.removeEventListener('resize', pruefen);
    abVollbild();
    querKacheln.abmelden(id);
  };
}
