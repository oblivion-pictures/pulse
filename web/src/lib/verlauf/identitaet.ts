/**
 * Wann zwei lokale Sätze dieselbe Nachricht sind — EINE Regel für alle
 * Duplikat-Stellen: den Sicherungs-Leser (`sicherung/eintragsGruppen.ts`),
 * den Anzeige-Merge (`zusammenfuegen.ts`) und den Nachrichten-Store
 * (`stores/messages.svelte.ts`, die Rechnung in `nachrichten/listenKern.ts`).
 *
 * **Warum es eine eigene Regel braucht.** Dieselbe verschlüsselte Nachricht
 * liegt auf jedem Gerät unter einer ANDEREN lokalen ID: beim Verfasser unter
 * der selbst gewählten (`krypto/senden.ts::lokaleNachrichtId`), bei jedem
 * Empfängergerät unter der Zustellungs-ID seines Umschlags, im Server-Archiv
 * wieder unter der des Verfassers. Die geräteübergreifende Kennung reist beim
 * EMPFANGENEN Satz als `kryptoId` mit; die Kopie des Verfassers trägt sie erst
 * seit 2026-10-13 (`krypto/senden.ts` setzt `krypto_id` gleich der `id`).
 * Verläufe und Sicherungen von davor enthalten sie ohne, und eine Sicherung
 * ist nicht nachträglich umschreibbar. Lange verglichen alle drei Stellen nur
 * `kryptoId` mit `kryptoId`; die Verfasser-Kopie (`id` = K, ohne `kryptoId`)
 * und die Empfangs-Kopie (`id` = D, `kryptoId` = K) galten damit als zwei
 * Nachrichten, und nach Gerätewechsel plus Wiederherstellung stand dieselbe
 * Nachricht doppelt da. Die kanonische Kennung ist deshalb `kryptoId || id`
 * (`kanonischeId`): einer Zeile ohne das Feld fehlt nur, was ihre eigene ID
 * schon ist.
 *
 * **Autor-Bindung ist Pflicht, kein Zierrat.** Die Kennung wählt der
 * Absender frei — er schreibt sie selbst in seine Nutzlast. Ohne den Autor im
 * Schlüssel könnte jeder Gesprächspartner eine Nachricht mit der Kennung
 * einer fremden schicken und sie damit als „Duplikat" verdrängen oder mit
 * ihr zusammenlegen lassen. Eine Zwischenfassung ohne Autor (c5a25317, am
 * 2026-10-13 kurz auf `main`) tat genau das: eine Nachricht des Partners mit
 * der Kennung einer eigenen verdrängte diese in der Anzeige, und löschte er
 * seine, war auch die eigene weg. Beim Postfach-Empfang stammt der Autor aus
 * der authentisierten Zustellung (`zustellungOeffnen.ts`). Im Server-Archiv
 * schreibt ihn der Einliefernde selbst in die Nutzlast, und einliefern darf
 * jedes Kanalmitglied; seit 2026-10-12 nennt der Server deshalb zu jeder
 * Zeile den Einlieferer, und eine Zeile, deren Autor nicht dazu passt, fällt
 * beim Lesen heraus (`archiv/zeile.ts::leseZeile`, Server
 * `routes/archiv.py`). Übergangsweise ausgenommen sind Bestandszeilen von
 * davor, die keinen Einlieferer kennen: ein gefälschter Bestands-Satz kann
 * auf einem Gerät erscheinen, das unter seinem Schlüssel nichts liegen hat;
 * an einem liegenden Satz desselben Kontos ergänzt er höchstens die Kennung
 * (`satz.ts::satzErgaenzen`).
 *
 * **Eine Löschung gilt über diese Regel nur, wenn ihr Autor feststeht.** Das
 * Grabstein-Register (`grabsteinRegister.ts`, seit 2026-10-12) hält
 * Löschungen genau unter diesem Schlüssel fest, damit eine Kopie unter einer
 * anderen lokalen ID gelöscht bleibt — eingetragen aber nur von einer
 * GEBUNDENEN Löschung: Lösch-Frame (Absender aus der Zustellung),
 * Grabstein-Zeile im Archiv (Einlieferer = Autor), Sicherungs-Stein mit
 * Autor, eigene Löschung (Autor aus dem liegenden Satz). Ein Sicherungs-
 * Stein ohne Autor (vor 2026-10-11) löst keine Identität auf: auf dem
 * wiederherstellenden Gerät trifft er nur den Satz unter seiner lokalen ID
 * (`sicherung/andockLesen.ts::steinAnwenden`). Im Leser der Sicherung
 * selbst legt er dagegen die Gruppe dieser ID still, samt ihrer anderen
 * lokalen IDs, und gibt für jede einen Stein mit dem Autor der Gruppe aus
 * (`sicherung/eintragsGruppen.ts`) — der Autor kommt dann aus den
 * Nachrichten-Rahmen der eigenen Sicherung, nicht aus dem Stein.
 *
 * Importfrei, damit Nodes eingebauter Testläufer die Datei ohne Bundler prüft
 * (s. CLAUDE.md „Die Falle"). Aus demselben Grund steht hier auch die Prüfung
 * der Kennungs-Form (`istGueltigeKennung`): Frame-Leser, Archiv-Zeile,
 * Grabstein-Register und Sicherungs-Leser holen sie alle von hier.
 */

const KENNUNG = /^[1-9][0-9]{0,19}$/;

/**
 * Ob ein Wert als Kennung taugt: eine Ziffernfolge mit 1 bis 20 Stellen ohne
 * führende Null — die Form jeder echten ID (Server-Snowflakes,
 * `krypto/lokaleNachrichtId.ts` mit 19 Stellen, Altbestand mit 20).
 *
 * **Alles, was ein Gesprächspartner frei wählt, ist feindliche Eingabe**
 * (Gegenprüfung 2026-10-12, Fund 1): die Kennung eines Lösch-Frames, die ID
 * einer Archiv-Zeile, eine Anhang-ID. Eine Kennung `"x"` landete bis dahin
 * über eine gebundene Löschung ohne lokalen Treffer im Grabstein-Register und
 * als Stein in der Sicherung, und deren Leser rechnete mit `BigInt`: jede
 * Wiederherstellung des Kanals warf, auf Dauer. Geprüft wird deshalb, bevor
 * etwas dauerhaft abgelegt wird.
 *
 * Ohne führende Null, weil `satz.ts::sortierSchluessel` auf 20 Stellen
 * auffüllt: `"0123"` und `"123"` landeten unter demselben Schlüssel, ein
 * zweiter Name für denselben Platz. Mehr als 20 Stellen hat keine 64-Bit-Zahl.
 */
export function istGueltigeKennung(wert: unknown): wert is string {
  return typeof wert === 'string' && KENNUNG.test(wert);
}

/** Die geräteübergreifende Kennung einer Nachricht: die vom Verfasser
 *  gewählte `kryptoId`, wo der Satz sie führt, sonst die eigene ID (beim
 *  Verfasser selbst, im Archiv, und bei Klartext-Nachrichten mit
 *  Server-ID). Eine leere Kennung zählt als fehlend. */
export function kanonischeId(id: string, kryptoId?: string | null): string {
  return kryptoId || id;
}

/** Der Duplikat-Schlüssel: Autor und kanonische Kennung. Ein fehlender Autor
 *  wird zur leeren Zeichenkette — zwei Sätze ohne Autor mit derselben Kennung
 *  sind damit dieselbe, aber nie einer mit und einer ohne Autor. */
export function nachrichtIdentitaet(
  autorId: string | null | undefined,
  id: string,
  kryptoId?: string | null
): string {
  return `${autorId ?? ''}:${kanonischeId(id, kryptoId)}`;
}
