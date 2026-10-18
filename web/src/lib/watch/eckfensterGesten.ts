/**
 * Die reine Rechnung hinter den Gesten des PiP-Eckfensters: wie sich Grösse
 * und Lage beim Zusammenziehen (zwei Finger) ändern, und wie das Fenster am
 * Bildschirm bleibt.
 *
 * **Das Modul hat bewusst KEINEN Laufzeit-Import** — es wird von Nodes
 * eingebautem Läufer geprüft (`pnpm test:unit`), und der löst die
 * erweiterungslosen Importe der Web-Quellen nicht auf.
 *
 * **Warum getrennt von der Komponente:** die Skalierungs-Rechnung (Finger-
 * abstand → Grösse, Mittelpunkt bleibt fix) ist die Stelle, an der ein
 * Denkfehler stumm bliebe — ein Zusammenziehen, das fälschlich als Verschieben
 * zählt, sieht aus wie „ruckelt eben“. Am Markup ist das nicht prüfbar, an
 * einer Funktion mit vier Zahlen schon.
 *
 * Seit 2026-10-19 skaliert der Pinch ÜBERALL auf der Fläche (Nutzerwunsch) —
 * die frühere Ecken-/Diagonal-Erkennung (ECKEN_TOLERANZ, eckeVon,
 * istDiagonale) ist entfernt: zwei Finger auf dem Fenster, fertig.
 */

export interface Lage {
  readonly top: number;
  readonly left: number;
}

export interface Groesse {
  readonly w: number;
  readonly h: number;
}

/** px — darunter gilt ein Pointer-Down als Tipp, nicht als Ziehen. */
export const TAP_TOLERANZ = 8;
/** px Abstand zum Bildschirmrand. */
export const MARGIN = 16;
export const MIN_W = 160;
export const MIN_H = 100;

/** Hält das Fenster vollständig im sichtbaren Bereich. */
export function einpassen(
  lage: Lage,
  groesse: Groesse,
  fenster: { innerWidth: number; innerHeight: number }
): Lage {
  const maxTop = Math.max(MARGIN, fenster.innerHeight - groesse.h - MARGIN);
  const maxLeft = Math.max(MARGIN, fenster.innerWidth - groesse.w - MARGIN);
  return {
    top: Math.min(Math.max(MARGIN, lage.top), maxTop),
    left: Math.min(Math.max(MARGIN, lage.left), maxLeft)
  };
}

/**
 * Neue Grösse aus dem Verhältnis der Fingerabstände — mit Untergrenze und mit
 * dem Bildschirm als Obergrenze. `startAbstand` wird gegen 1 abgesichert:
 * zwei Finger exakt aufeinander gäben sonst eine Division durch null.
 */
export function skalieren(
  start: Groesse,
  startAbstand: number,
  abstand: number,
  fenster: { innerWidth: number; innerHeight: number }
): Groesse {
  const faktor = abstand / Math.max(1, startAbstand);
  return {
    w: Math.max(MIN_W, Math.min(fenster.innerWidth - 2 * MARGIN, start.w * faktor)),
    h: Math.max(MIN_H, Math.min(fenster.innerHeight - 2 * MARGIN, start.h * faktor))
  };
}

/** Abstand zweier Punkte — als eigene Funktion, damit die Tests sie teilen. */
export function abstand(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
