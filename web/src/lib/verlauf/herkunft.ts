/**
 * Sätze aus dem Archiv, deren Autor niemand geprüft hat — und wohin sie
 * nicht wandern dürfen (Gegenprüfung 2026-10-12, Fund 4).
 *
 * Bestandszeilen von vor Migration 0103 kennen ihren Einlieferer nicht, und
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
 * Hier steht außerdem die Gegenseite von `fuerUmzug`: was die Kopplung auf dem
 * NEUEN Gerät ablegt (`ausUmzug`).
 *
 * Importfrei bis auf `.ts`-Pfade (Nodes Testläufer).
 */
import { istGueltigeKennung } from './identitaet.ts';
import { sortierSchluessel } from './satz.ts';

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

/** Der Ausschnitt eines übernommenen Satzes, den `ausUmzug` liest. */
type UmzugSatz = MitHerkunft & {
  schluessel: string;
  kanalId: string;
  nachrichtId: string;
  kryptoId: string | null;
  kontoId: string;
};

/**
 * Was die Kopplung vom alten Gerät ablegt (`kopplung/empfangen.ts`): jeder
 * Satz mit dem Konto DIESES Geräts gestempelt (Befund 1, 2026-08-29) und mit
 * einem Schlüssel, der aus Kanal und ID neu gerechnet ist — nicht aus dem
 * Stück übernommen.
 *
 * Ein Satz, dessen Kanal oder ID keine Kennung ist, fällt weg, eine
 * ungültige `kryptoId` wird `null` (Gegenprüfung 2026-10-12, Fund 1): das alte
 * Gerät kann einen Satz aus einer Zeit halten, bevor die Leser das prüften,
 * und nur was eine gültige Kennung trägt, wird dauerhaft abgelegt.
 * Ungeprüftes fällt weg wie beim Senden (`fuerUmzug`) — für ein altes Gerät,
 * das es noch schickt.
 */
export function ausUmzug<S extends UmzugSatz>(saetze: S[], kontoId: string): S[] {
  return fuerUmzug(saetze)
    .filter((satz) => istGueltigeKennung(satz.kanalId) && istGueltigeKennung(satz.nachrichtId))
    .map((satz) => ({
      ...satz,
      kontoId,
      schluessel: sortierSchluessel(satz.kanalId, satz.nachrichtId),
      kryptoId: istGueltigeKennung(satz.kryptoId) ? satz.kryptoId : null
    }));
}
