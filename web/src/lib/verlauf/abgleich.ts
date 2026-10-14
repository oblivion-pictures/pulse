/**
 * Reine Rechnung fuer den Hintergrund-Abgleich einer bereits ausgelieferten
 * lokalen Seite gegen den Server (`nachladen.ts::reconciliereAeltereSeite`,
 * Bughunt Fund 3) — importfrei, damit Nodes Testlaeufer sie direkt prueft
 * (s. CLAUDE.md „Die Falle").
 */

/** Ermittelt, welche lokal gehaltenen IDs in der Serverantwort NICHT mehr
 *  auftauchen. Der Server liefert geloeschte Nachrichten grundsaetzlich
 *  nicht aus (`Message.deleted_at.is_(None)`-Filter, s.
 *  `zusammenfuegen.ts`-Kommentar) — "fehlt in der Antwort" ist hier also der
 *  REGELFALL fuer eine zwischenzeitliche Loeschung, kein Sonderfall. Anders
 *  als beim Merge in `zusammenfuegen.ts` gibt es hier keinen lokalen
 *  Grabstein-Vorrang zu beachten: die Spanne war bereits lokal bekannt, ein
 *  Fehlen kann also nicht "Historie-Ende" bedeuten. */
export function ermittleGeloeschteIds(
  lokal: { id: string; verschluesselt?: boolean }[],
  vomServer: { id: string }[],
  fenster: ServerFenster
): string[] {
  const nochVorhanden = new Set(vomServer.map((m) => m.id));
  const imFenster = abgedeckt(vomServer, fenster);
  // **Verschluesselte Nachrichten NIE ueber den Server abgleichen.** Der
  // Server hat sie nie gesehen — fuer sie ist „fehlt in der Antwort" der
  // Normalzustand, nicht eine Loeschung. Bis zum 2026-09-03 stand das hier
  // nicht, und auf einem Geraet mit lokalem Verlauf (Flatpak-App, Archiv
  // angeschlossen) markierte ein einziges Hochscrollen JEDE verschluesselte
  // Nachricht der Seite als geloescht — nachgezaehlt: 25 von 29, davon 19
  // eigene — und schrieb dazu Grabsteine ins Archiv, die der naechste Start
  // wieder anwandte. Sichtbar wurde es als „alle Nachrichten von dev sind
  // nach einem Neuladen weg". Der Browser des anderen Nutzers sah es nicht:
  // ein frisches Geraet hat keine lokale Seite, also nichts abzugleichen.
  return lokal
    .filter((n) => n.verschluesselt !== true && imFenster(n.id) && !nochVorhanden.has(n.id))
    .map((n) => n.id);
}

/** Die Anfrage, auf die `vomServer` antwortet: `listMessages(before, limit)`. */
export type ServerFenster = { before: string; limit: number };

const ZIFFERN = /^[1-9][0-9]*$/;

/** **Geurteilt wird nur über das Fenster, das die Antwort wirklich abdeckt**
 *  (Gegenprüfung 2026-10-14, W1). Der Server liefert die `limit` numerisch
 *  größten IDs unter `before` — bei Klartext ist die ID eine Snowflake,
 *  numerisch heißt dort zeitlich. Ein lokaler Satz ist also nur dann
 *  geprüft, wenn seine ID unter `before` liegt und, bei einer VOLLEN
 *  Antwort, nicht unter der kleinsten gelieferten: was darunter liegt, hat
 *  der Server gar nicht gezeigt. Die lokale Seite meint seit V2 „älter in der
 *  Zeit“, und sie reicht über eine eigene Nachricht hinweg tiefer in den
 *  Klartext als die Serverseite — ohne diese Grenze galt jeder Klartext-Satz
 *  unterhalb der Antwort als gelöscht, und eine Löschung im Verlauf lässt
 *  sich nicht zurücknehmen (Register, Sicherungs-Stein). Eine ID, die keine
 *  Ziffernfolge ist (`tmp-`), ist nie geprüft. */
function abgedeckt(vomServer: { id: string }[], fenster: ServerFenster): (id: string) => boolean {
  const oben = BigInt(fenster.before);
  let unten = 0n;
  if (vomServer.length >= fenster.limit) {
    unten = vomServer.reduce((min, m) => {
      const id = BigInt(m.id);
      return id < min ? id : min;
    }, oben);
  }
  return (id) => {
    if (!ZIFFERN.test(id)) return false;
    const zahl = BigInt(id);
    return zahl < oben && zahl >= unten;
  };
}
