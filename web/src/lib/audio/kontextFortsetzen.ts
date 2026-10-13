/**
 * Einen angehaltenen `AudioContext` fortsetzen — ohne Import (Pflicht für
 * `pnpm test:unit`, s. CLAUDE.md).
 *
 * Browser starten einen AudioContext nur nach einer Nutzergeste. Chrome und
 * Firefox merken sie sich für die Seite; WebKit (Safari), so die gängige Lesart
 * (hier nicht in der Quelle nachgelesen, nicht in Safari gefahren), nur für die
 * Geste selbst oder solange aufgenommen wird. Ein Kontext, der angelegt wird,
 * wenn die Geste lange zurückliegt — der erste Ton eines Raums, der erst nach
 * dem Handschlag ankommt —, bleibt dann angehalten, und sein `resume()`
 * scheitert oder bleibt offen. Eine Seite ohne eigenen „Ton aktivieren“-Knopf
 * (die Gastseite) wäre stumm, ohne es zu zeigen.
 *
 * `kontextFortsetzen` versucht es sofort und hängt sich zusätzlich an die
 * nächste Geste auf der Seite, egal wie das `resume()` ausgeht. Jede Geste
 * versucht es erneut, bis der Kontext läuft; danach lösen sich die Zuhörer von
 * selbst. Je Kontext höchstens ein Satz Zuhörer, mehrfaches Aufrufen stapelt
 * nichts.
 *
 * Welche Ereignisse als Geste zählen, hängt vom Browser und von der Eingabeart
 * ab (Maus, Berührung, Taste); deshalb lauscht es auf mehrere.
 */

/** Was die Funktion vom Kontext braucht — ein Test kann es nachbauen. */
export type FortsetzbarerKontext = Pick<AudioContext, 'state' | 'resume'>;

const GESTEN = ['pointerdown', 'pointerup', 'keydown', 'touchend', 'click'] as const;

/** Kontexte, an denen schon gelauscht wird. */
const wartend = new WeakSet<object>();

/** Den Kontext fortsetzen; läuft er danach (noch) nicht, bei der nächsten Geste
 *  auf `ziel` (die Seite) noch einmal. Ein geschlossener oder laufender Kontext
 *  bleibt unberührt. */
export function kontextFortsetzen(ctx: FortsetzbarerKontext, ziel: EventTarget = document): void {
  if (ctx.state === 'running' || ctx.state === 'closed') return;
  void ctx.resume().catch(() => undefined);
  aufGesteWarten(ctx, ziel);
}

function aufGesteWarten(ctx: FortsetzbarerKontext, ziel: EventTarget): void {
  if (wartend.has(ctx)) return;
  wartend.add(ctx);
  const abbauen = () => {
    for (const art of GESTEN) ziel.removeEventListener(art, gehoert, true);
    wartend.delete(ctx);
  };
  const gehoert = () => {
    if (ctx.state === 'running' || ctx.state === 'closed') return abbauen();
    // Erst nach gelungenem Fortsetzen abbauen: bei einer Berührung zählt oft erst
    // das spätere Ereignis (`pointerup`/`touchend`) als Geste, das kommt dann noch.
    void ctx.resume().then(
      () => {
        if (ctx.state === 'running') abbauen();
      },
      () => undefined
    );
  };
  for (const art of GESTEN) ziel.addEventListener(art, gehoert, true);
}
