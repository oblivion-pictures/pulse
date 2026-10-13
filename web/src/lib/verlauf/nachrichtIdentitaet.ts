/**
 * Woran zwei Kopien als DIESELBE Nachricht erkannt werden — die eine Regel
 * für alle Stellen, die Kopien zusammenführen: den Anzeige-Merge
 * (`zusammenfuegen.ts`), den Wiederherstellungs-Leser
 * (`sicherung/wiederherstellen.ts`), den Nachrichten-Store
 * (`stores/messages.svelte.ts`) und die Verlaufs-Suche nach einer
 * kanonischen Id (`db.ts::verlaufSatzIdFuerKryptoId`).
 *
 * **Die Identität einer verschlüsselten Nachricht ist die Id, die ihr AUTOR
 * gewählt hat** (`krypto/lokaleNachrichtId.ts`, reist im Umschlag mit). Jedes
 * Gerät legt sie aber unter einer eigenen lokalen Id ab: der Autor unter
 * genau dieser Id, jedes empfangende Gerät — auch das zweite eigene des
 * Autors, das die Selbstzustellung bekommt — unter der Id seiner Zustellung,
 * mit der Autor-Id als `kryptoId` daneben.
 *
 * **Warum `kryptoId ?? id` und nicht nur `kryptoId`.** Bis zum 2026-10-13
 * trug die Kopie des Autors KEINE `kryptoId` (der Sendeweg setzte sie nicht,
 * `krypto/senden.ts`). Seither setzt er sie (`kryptoId = id`), aber lokale
 * Verläufe und Sicherungen von davor enthalten diese Zeilen weiter ohne —
 * und eine Sicherung ist nicht nachträglich umschreibbar. Für genau diese
 * Zeilen IST die eigene `id` die Autor-Id: der Autor hat sie gewählt und
 * unter ihr abgelegt. Der Rückfall stellt also keine Vermutung an, sondern
 * liest das fehlende Feld aus dem Wert, den es heute bekäme.
 *
 * **Warum der Rückfall auf andere Zeilen ohne `kryptoId` nichts verklebt.**
 * Ohne `kryptoId` liegen sonst nur Zeilen unter einer Server-Snowflake
 * (Klartext-Nachrichten, Empfangs-Kopien von Absendern, deren Nutzlast noch
 * keine Id trug, Grabsteine eines Empfängergeräts in der Sicherung) oder
 * unter einer vorläufigen `tmp-`-Kennung der Anzeige. Gleich wird ihre
 * Identität damit nur einer Zeile mit derselben `id` (das war schon immer
 * dieselbe Nachricht) oder einer `kryptoId` mit demselben Wert. Das Zweite
 * setzt voraus, dass eine Server-Snowflake einer vom Autor gewählten Id
 * gleicht: die einen haben heute höchstens 18 Stellen (19 erst ab Mitte 2033;
 * `utils/snowflakeZeit.ts` unterscheidet beide schon heute an der Länge),
 * die anderen 19 mit 13 Stellen Zeitstempel und 6 Zufallsstellen (Altbestand
 * vor dem 2026-09-02: 20, `krypto/lokaleNachrichtId.ts`).
 * Darüber hinaus nimmt die Regel nichts an, was die bisherige nicht schon
 * annahm: dass zwei vom Autor gewählte Ids nicht kollidieren — darauf ruht
 * der `kryptoId`-Abgleich seit dem 2026-09-11.
 *
 * Importfrei (s. CLAUDE.md, `pnpm test:unit`-Falle).
 */

/** Die geräteübergreifende Identität einer Kopie: die vom Autor gewählte Id
 *  (`kryptoId`), bei Zeilen ohne dieses Feld die eigene `id` (s. Modulkopf). */
export function kanonischeNachrichtId(id: string, kryptoId?: string | null): string {
  return kryptoId ?? id;
}

/**
 * Ob eine ankommende Kopie (`id`, `kryptoId`) eine schon gehaltene Nachricht
 * ist — die Prüfung des Nachrichten-Stores (`stores/messages.svelte.ts`), der
 * je Kanal die gehaltenen `id`s und die gehaltenen `kryptoId`s führt.
 *
 * Geprüft werden die eigene `id` und die kanonische Id der Ankunft, die
 * kanonische gegen BEIDE Mengen: hält der Store die Kopie des Autors aus
 * einem Altbestand, steht deren Id (die kanonische) nur unter den `id`s, denn
 * sie hat keine `kryptoId`; hält er die Kopie eines empfangenden Geräts,
 * steht die kanonische Id unter den `kryptoId`s.
 */
export function istBekannteNachricht(
  id: string,
  kryptoId: string | null | undefined,
  bekannteIds: ReadonlySet<string>,
  bekannteKryptoIds: ReadonlySet<string>
): boolean {
  const kanonisch = kanonischeNachrichtId(id, kryptoId);
  return bekannteIds.has(id) || bekannteIds.has(kanonisch) || bekannteKryptoIds.has(kanonisch);
}
