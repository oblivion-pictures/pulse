/**
 * Svelte-Aktion: lässt ein Element kurz „aufploppen“ (Scale 1 → 1.15 → 1,
 * ~250 ms), wenn die übergebene Zahl GEGENÜBER DEM LETZTEN WERT steigt.
 *
 * Gedacht für den Zähler einer Reaktions-Pille am Handy. Absichtlich eine
 * Aktion mit Web-Animations-API statt einer CSS-Klasse: eine Klasse müsste
 * für jeden Pop entfernt und neu gesetzt werden, damit die Animation erneut
 * läuft. Und: das erste Mounten (auch das Wiederverwenden einer Zeile durch
 * die Virtualisierung) merkt sich nur den Wert und animiert NICHT — es ploppt
 * allein eine echte Zunahme.
 *
 * Nur `transform`. „Bewegung reduzieren“ und `aktiv: false` (Desktop) → nichts.
 * Reine `.ts`-Datei ohne Runen.
 */
export interface ZahlPopParam {
  zahl: number;
  /** Aus → nur mitzählen, nie animieren (Desktop/Tablet). */
  aktiv: boolean;
}

export const POP_DAUER_MS = 250;
const FEDER = 'cubic-bezier(0.32, 0.72, 0, 1)';

export function zahlPop(
  node: HTMLElement,
  param: ZahlPopParam
): { update: (neu: ZahlPopParam) => void } {
  let letzte = param.zahl;
  return {
    update(neu: ZahlPopParam) {
      const stieg = neu.zahl > letzte;
      letzte = neu.zahl;
      if (!stieg || !neu.aktiv) return;
      if (typeof node.animate !== 'function') return;
      if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }
      node.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.15)', offset: 0.4 }, { transform: 'scale(1)' }],
        { duration: POP_DAUER_MS, easing: FEDER }
      );
    }
  };
}
