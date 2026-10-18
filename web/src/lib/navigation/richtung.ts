/**
 * In welche Richtung die laufende Navigation geht — ohne `onNavigate`/
 * View-Transitions (die brachten in dieser App den Boot zum Absturz, s.
 * `app.css`). Wer „zurück" auslöst (Pfeil, Android-Taste, Wischgeste), setzt
 * vorher den Merker; die Seiten, die neu erscheinen, lesen ihn beim Mounten
 * und wählen ihre Eintritts-Animation (`slide-rein`/`slide-zurueck`).
 *
 * Importfrei (Pflicht für `pnpm test:unit`) und ohne Runen: ein schlichtes
 * Modul-`let` genügt, denn gelesen wird nur beim Mounten. Der Merker wird
 * NICHT beim Lesen verbraucht (mehrere Komponenten einer Navigation fragen),
 * sondern nach der Navigation zurückgesetzt (`zuruecksetzen`, im
 * App-Layout) — und verfällt nach {@link GUELTIG_MS}, falls eine Navigation
 * ausfällt (gleicher Pfad) und das Zurücksetzen nie kommt.
 */
export type Richtung = 'vor' | 'zurueck' | 'wischen';

/** Wie lange ein gesetzter Merker höchstens gilt (ms). */
export const GUELTIG_MS = 3000;

let aktuell: Richtung = 'vor';
let gesetztUm = 0;

/**
 * Die nächste Navigation ist ein Zurück. `wischen`: die Seite ist schon mit
 * dem Finger hinausgeglitten — die Elternseite erscheint ohne eigene
 * Animation (sonst liefe es doppelt).
 */
export function markiereZurueck(art: 'zurueck' | 'wischen' = 'zurueck', jetzt = Date.now()): void {
  aktuell = art;
  gesetztUm = jetzt;
}

/** Der Merker, oder `vor`, wenn keiner gesetzt ist oder er verfallen ist. */
export function richtung(jetzt = Date.now()): Richtung {
  return jetzt - gesetztUm <= GUELTIG_MS ? aktuell : 'vor';
}

/** Nach jeder abgeschlossenen Navigation. */
export function zuruecksetzen(): void {
  aktuell = 'vor';
}

/**
 * Die Eintritts-Klasse einer Seite (CSS in `app.css`, nur am Handy):
 *
 * - `detail`: ein Bildschirm, der beim Vorwärts von rechts hereinkommt.
 * - `wurzel`: ein Bereich der Tab-Leiste; beim Wechsel nur kurz eingeblendet.
 *
 * Nach einem Zurück kommt der Bildschirm von links (`slide-zurueck`); nach
 * einem Wischen ohne Animation, weil die Geste sie schon gespielt hat.
 */
export function seitenKlasse(r: Richtung, rolle: 'detail' | 'wurzel'): string {
  if (r === 'wischen') return '';
  if (r === 'zurueck') return 'slide-zurueck';
  return rolle === 'detail' ? 'slide-rein' : 'bereich-blende';
}

/** `seitenKlasse` für die Richtung der laufenden Navigation — beim Mounten aufrufen. */
export function eintrittsKlasse(rolle: 'detail' | 'wurzel'): string {
  return seitenKlasse(richtung(), rolle);
}
