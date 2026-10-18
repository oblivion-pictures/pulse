/**
 * Die Feder-Kurve der Handy-Bewegungen (Blatt von unten, Rückfedern, Dialog-
 * Blatt): schneller Anlauf, weiches Auslaufen, angelehnt an das System-Blatt auf iOS.
 * Importfrei (Nodes Läufer, `pnpm test:unit`), keine Runen.
 *
 * EINE Quelle pro Sprache: hier für Skripte, als `--feder` in `app.css` für
 * Klassen (`ease-[var(--feder)]`). Wer die Zahlen ändert, ändert beide Stellen.
 */
export const FEDER_PUNKTE = [0.32, 0.72, 0, 1] as const;

/** Dasselbe als CSS-Wert (für `element.style.transition`). */
export const FEDER = `cubic-bezier(${FEDER_PUNKTE.join(',')})`;

/**
 * Löst `cubic-bezier(x1,y1,x2,y2)` als Funktion `t → Fortschritt` auf. Gebraucht
 * für Svelte-Übergänge: Svelte tastet `css(t)` selbst ab und braucht die Kurve
 * als JS-Funktion, ein CSS-Wert wirkt dort nicht.
 */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (s: number): number => ((ax * s + bx) * s + cx) * s;
  const y = (s: number): number => ((ay * s + by) * s + cy) * s;
  const dx = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;

  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton, bei flacher Steigung Halbierung.
    let s = t;
    for (let i = 0; i < 6; i++) {
      const fehler = x(s) - t;
      if (Math.abs(fehler) < 1e-5) return y(s);
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= fehler / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 24; i++) {
      const v = x(s);
      if (Math.abs(v - t) < 1e-5) break;
      if (v < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return y(s);
  };
}

/** `FEDER` als JS-Kurve. */
export const federKurve = bezier(...FEDER_PUNKTE);
