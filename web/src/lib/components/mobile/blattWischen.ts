/**
 * Die Rechnung hinter dem Wegwischen eines Blattes von unten
 * (`BottomSheet.svelte`). Importfrei, damit Nodes Läufer sie prüfen kann.
 *
 * Gezogen wird nur am Kopf des Blattes (Griff-Strich und Titelzeile): der Rest
 * ist Inhalt und scrollt. Ein Blatt, das überall wegzuwischen wäre, finge jedes
 * Scrollen ab.
 */

/** Höhe des ziehbaren Kopfes in px, gemessen von der Oberkante des Blattes. */
export const KOPF_HOEHE = 64;

/** Ab wie viel Bewegung (px) aus einem Antippen eine Wischgeste wird. */
export const WISCH_SCHWELLE = 8;

/** Anteil der Blatthöhe, ab dem es beim Loslassen weggeht. */
const WEG_ANTEIL = 0.3;
/** Geschwindigkeit (px/ms), ab der eine kurze Wischbewegung genügt. */
const WEG_TEMPO = 0.5;
/** Mindestweg (px) für eine schnelle Geste — sonst löste jedes Zucken aus. */
const WEG_MINDESTWEG = 40;

export interface Probe {
  y: number;
  t: number;
}

/** Liegt der Berührungspunkt im ziehbaren Kopf des Blattes? */
export function imKopf(y: number, blattOberkante: number): boolean {
  const abstand = y - blattOberkante;
  return abstand >= 0 && abstand <= KOPF_HOEHE;
}

/** Überwiegt die senkrechte Bewegung? (Waagrechtes bleibt dem Inhalt.) */
export function senkrecht(dx: number, dy: number): boolean {
  return Math.abs(dy) > Math.abs(dx);
}

/**
 * Wie weit das Blatt der Fingerbewegung folgt. Nach unten 1:1; nach oben
 * zäh (Gummiband), damit es nicht beliebig hoch aus dem Bild gezogen wird.
 */
export function versatz(dy: number): number {
  return dy >= 0 ? dy : dy / 6;
}

/** Geschwindigkeit nach unten in px/ms über die letzten ~100 ms. */
export function tempo(proben: Probe[]): number {
  if (proben.length < 2) return 0;
  const ende = proben[proben.length - 1];
  let start = proben[0];
  for (const p of proben) {
    if (ende.t - p.t <= 100) {
      start = p;
      break;
    }
  }
  const dt = ende.t - start.t;
  return dt > 0 ? (ende.y - start.y) / dt : 0;
}

/** Geht das Blatt beim Loslassen weg (sonst federt es zurück)? */
export function weg(dy: number, blattHoehe: number, geschwindigkeit: number): boolean {
  if (dy <= 0) return false;
  if (dy >= blattHoehe * WEG_ANTEIL) return true;
  return dy >= WEG_MINDESTWEG && geschwindigkeit >= WEG_TEMPO;
}
