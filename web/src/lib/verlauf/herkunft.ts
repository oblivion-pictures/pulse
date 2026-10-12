/**
 * Sätze aus dem Archiv, deren Autor niemand geprüft hat — und wohin sie
 * nicht wandern dürfen (Gegenprüfung 2026-10-12, Fund 4).
 *
 * Bestandszeilen von vor Migration 0102 kennen ihren Einlieferer nicht, und
 * `archiv/zeile.ts::leseZeile` nimmt sie übergangsweise trotzdem an
 * (`BESTANDSZEILEN_ANNEHMEN`). Ihren Autor `a` schrieb der Einliefernde
 * selbst hinein: Bob konnte eine Zeile `{i: K, a: Alice, anh: […]}` als Alices
 * Nachricht ausgeben. Auf einem Frisch- oder Zweitgerät wurde daraus ein
 * voller Satz, die Erstsicherung schrieb ihn in Alices EIGENE Sicherung, und
 * beim Wiederherstellen galt er als ihre eigene Wahrheit: er ersetzte als
 * „reichere" Fassung den echten Rahmen (`sicherung/eintragsGruppen.ts`) und
 * durfte als Nachschub aus der Sicherung (`satz.ts::satzErgaenzen` mit
 * `herkunft === 'sicherung'`) Anhänge an ihrem Satz ergänzen.
 *
 * Solche Sätze tragen deshalb `ungeprueft` (`satz.ts::zuSatz` aus
 * `archiv_ungeprueft`), und:
 *
 *   - die Erstsicherung und die Kopplung nehmen sie nicht mit
 *     (`fuerErstsicherung`, `fuerUmzug`) — nur geprüfter Bestand wird zu
 *     eigener Wahrheit;
 *   - jeder geprüfte Satz desselben Autors ersetzt einen ungeprüften unter
 *     demselben Schlüssel (`satz.ts::satzErgaenzen`), nie umgekehrt;
 *   - ihre Anhänge räumt keine Löschung von Gerät und Laufwerk
 *     (`loeschFolgen.ts`).
 *
 * Importfrei (Nodes Testläufer).
 */

type MitHerkunft = { ungeprueft?: true };

/** Ob ein Satz aus einer Archiv-Zeile ohne geprüften Autor stammt. */
export function istUngeprueft(satz: MitHerkunft): boolean {
  return satz.ungeprueft === true;
}

/** Was die Erstsicherung aus dem lokalen Verlauf in die eigene Sicherung
 *  schreibt: keine Grabsteine und nichts Ungeprüftes. */
export function fuerErstsicherung<S extends MitHerkunft & { geloescht: boolean }>(
  saetze: S[]
): S[] {
  return saetze.filter((satz) => !satz.geloescht && !istUngeprueft(satz));
}

/** Was eine Kopplung zum neuen Gerät schiebt: alles außer Ungeprüftem.
 *  Grabsteine reisen mit — sie löschen dort die Kopien derselben Nachricht. */
export function fuerUmzug<S extends MitHerkunft>(saetze: S[]): S[] {
  return saetze.filter((satz) => !istUngeprueft(satz));
}
