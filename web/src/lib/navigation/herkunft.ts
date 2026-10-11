/**
 * Woher kam die Navigation, die den gerade gezeigten Bildschirm geöffnet hat?
 *
 * **Eine Frage, die bis zum 2026-10-11 niemand stellte, und die drei Funde
 * des zweiten iOS-Bughunts trugen.** Die Kanal-Route tritt am Handy einem
 * Sprachkanal bei, sobald man auf ihm landet. Gedacht war das für den Tipp in
 * der App; es griff aber bei JEDER Landung:
 *
 *  - **D1** — ein Universal Link (iMessage, QR-Code) auf einen Sprachkanal
 *    trat ungefragt bei, mit offenem Mikrofon;
 *  - **N1** — ein Neuladen auf der Sprachkanal-Seite trat neu bei, bevor der
 *    Abgleich mit der Hülle lief, und verdrängte den überlebenden Raum samt
 *    Stumm und Taub;
 *  - **D2** — hatte der Nutzer in der Hülle aufgelegt, während die Oberfläche
 *    tot war, trat das Neuladen auf derselben Adresse wieder bei.
 *
 * Die Regel dagegen ist eine einzige: **beigetreten wird nur bei einer
 * Navigation IN der App** (`app`). Der Rest landet auf der Seite, ohne
 * beizutreten — sie zeigt dann den Beitreten-Knopf.
 *
 *  - `start`  — die erste Seite des Dokuments: Kaltstart, Neuladen, ein
 *               WebContent-Absturz, den die Hülle mit `reload()` heilt.
 *               Das Wiederaufnehmen nach einem Neuladen gehört dem
 *               Resume-Eintrag (`voice/resume.ts`), nicht der Adresse.
 *  - `aussen` — ein Ziel, das von ausserhalb der Seite hereingereicht wurde
 *               (`navigationsHerkunft.ts::vonAussenOeffnen`).
 *  - `zurueck` — Zurück/Vor im Verlauf. Kein Tipp auf den Kanal: wer nach
 *               dem Auflegen zurückwischt, will nicht wieder hinein.
 *  - `weiterleitung` — eine Navigation, die die App selbst auslöst, ohne
 *               dass jemand getippt hat (`navigationsHerkunft.ts::weiterleiten`):
 *               die Startseite `/app`, die auf das Auto-Connect-Ziel
 *               weiterleitet, und der Auto-Connect selbst. Nachprüfung der
 *               Fix-Runden, S1: die Weiterleitung von `/app` war ein `goto`
 *               und galt damit als Tipp — die Kanal-Route trat nach dem Tor
 *               bei, auch dort, wo der Auto-Connect mit Absicht NICHT
 *               beigetreten war (schon auf einem anderen Gerät im Kanal,
 *               Tab im Hintergrund). Der Beitritt gehört dann allein ihm.
 *
 * Importfrei, damit Nodes Testläufer die Einordnung prüfen kann (CLAUDE.md,
 * `pnpm test:unit`-Falle).
 */

export type Herkunft = 'start' | 'app' | 'aussen' | 'zurueck' | 'weiterleitung';

/** Ein Ziel, das für die nächste Navigation angemeldet wurde, und als was
 *  es landen soll (`navigationsHerkunft.ts`). */
export interface Marke {
  ziel: string;
  herkunft: 'aussen' | 'weiterleitung';
}

/**
 * Eine Navigation einordnen. `typ` ist SvelteKits `navigation.type`
 * (`link`, `goto`, `popstate`, `form`; `enter` gibt es nur beim ersten
 * Laden), `zielPfad` der Pfad, auf dem sie landet, `marke` das Ziel, das
 * zuletzt als „von aussen" oder als Weiterleitung angemeldet wurde.
 *
 * Verglichen wird nur der Pfad: Query und Anker ändern nicht, auf welchem
 * Bildschirm man landet.
 */
export function herkunftEinordnen(
  typ: string,
  zielPfad: string,
  marke: Marke | null
): Herkunft {
  if (typ === 'enter') return 'start';
  if (typ === 'popstate') return 'zurueck';
  if (marke !== null && nurPfad(marke.ziel) === zielPfad) return marke.herkunft;
  return 'app';
}

/** `/app/@me/1?x=2#y` → `/app/@me/1`. */
export function nurPfad(ziel: string): string {
  const ende = ziel.search(/[?#]/);
  return ende === -1 ? ziel : ziel.slice(0, ende);
}
