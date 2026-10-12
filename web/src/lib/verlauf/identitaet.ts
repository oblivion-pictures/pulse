/**
 * Wann zwei lokale Sätze dieselbe Nachricht sind — EINE Regel für alle
 * Duplikat-Stellen: den Sicherungs-Leser (`sicherung/eintragsGruppen.ts`),
 * den Anzeige-Merge (`zusammenfuegen.ts`) und den Nachrichten-Store
 * (`stores/messages.svelte.ts`).
 *
 * **Warum es eine eigene Regel braucht.** Dieselbe verschlüsselte Nachricht
 * liegt auf jedem Gerät unter einer ANDEREN lokalen ID: beim Verfasser unter
 * der selbst gewählten (`krypto/senden.ts::lokaleNachrichtId`), bei jedem
 * Empfängergerät unter der Zustellungs-ID seines Umschlags, im Server-Archiv
 * wieder unter der des Verfassers. Die geräteübergreifende Kennung reist nur
 * beim EMPFANGENEN Satz als `kryptoId` mit — die Kopie des Verfassers trägt
 * sie nicht, weil ihre `id` sie schon ist. Bis 2026-10-11 verglichen alle drei
 * Stellen nur `kryptoId` mit `kryptoId`; die Verfasser-Kopie (`id` = K, ohne
 * `kryptoId`) und die Empfangs-Kopie (`id` = D, `kryptoId` = K) galten damit
 * als zwei Nachrichten, und nach Gerätewechsel plus Wiederherstellung stand
 * dieselbe Nachricht doppelt da. Die kanonische Kennung ist deshalb
 * `kryptoId ?? id`.
 *
 * **Autor-Bindung ist Pflicht, kein Zierrat.** Die Kennung wählt der
 * Absender frei — er schreibt sie selbst in seine Nutzlast. Ohne den Autor im
 * Schlüssel könnte jeder Gesprächspartner eine Nachricht mit der Kennung
 * einer fremden schicken und sie damit als „Duplikat" verdrängen oder mit
 * ihr zusammenlegen lassen. Beim Postfach-Empfang stammt der Autor aus der
 * authentisierten Zustellung (`zustellungOeffnen.ts`). Im Server-Archiv
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
 * **Grabsteine werden NICHT über diese Regel aufgelöst.** Ein Grabstein-Rahmen
 * der Sicherung trifft eine Nachricht über ihre lokalen IDs, nie über diesen
 * Schlüssel. Ältere Steine tragen nur ihre ID; ein Stein, der seinen Autor
 * nennt (seit 2026-10-11), zählt seine Kennung zusätzlich als lokale ID —
 * und trifft damit nur Sätze dieses Autors, genau wie ein Lösch-Frame von
 * ihm (`sicherung/eintragsGruppen.ts`, `sicherung/andock.ts::steinAnwenden`).
 *
 * Importfrei, damit Nodes eingebauter Testläufer die Datei ohne Bundler prüft
 * (s. CLAUDE.md „Die Falle").
 */

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
