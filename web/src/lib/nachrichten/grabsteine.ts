/**
 * Die Grabsteine des Nachrichten-Stores (`stores/messages.svelte.ts`): die
 * kanonische `krypto_id` jeder Nachricht, die in dieser Sitzung aus einem Kanal
 * gelöscht wurde.
 *
 * **Wozu.** Dieselbe verschlüsselte Nachricht trägt auf jedem Gerät eine andere
 * lokale Id und ist nur an ihrer `krypto_id` wiederzuerkennen
 * (`verlauf/nachrichtIdentitaet.ts`). Der Store lässt die `krypto_id` einer
 * gelöschten Nachricht deshalb in der Dublettenmenge stehen: kommt später eine
 * Kopie unter anderer Id (Archiv- oder Sicherungs-Nachzug, Hochscrollen), gilt
 * sie als bekannt und erscheint nicht wieder. Der Verlauf-Merge
 * (`verlauf/zusammenfuegen.ts`) verdeckt eine solche Kopie nur, wenn Grabstein
 * und Kopie ihm gemeinsam vorgelegt werden — der Store füllt aber seitenweise
 * (`verlaufLesen` liefert ein Fenster), die beiden können in verschiedenen
 * Fenstern liegen.
 *
 * **Warum eine eigene Menge.** Die Dublettenmenge `krypto` ist ansonsten eine
 * Funktion der Liste (nur, was wirklich dort steht, `listenKern.ts::
 * mengenAbgleichen`) und wird beim Kappen aus ihr neu gebaut. Ein Grabstein
 * steht per Definition NICHT in der Liste; ohne eigenen Platz fiel er mit dem
 * Neuaufbau heraus. Hier steht er, der Abgleich spielt ihn danach zurück.
 *
 * **Lebensdauer.** Wie die Dublettenmengen selbst: bis der Kanal im Speicher
 * neu geladen (`setInitial`), geräumt (`clearChannel`, LRU-Deckel) oder die
 * Sitzung beendet wird (`clear`). Danach ist der lokale Verlauf die Quelle: für
 * lokal geführte Kanäle (DM, private Gruppe) schreibt `verlaufNachrichtGeloescht`
 * dort einen dauerhaften Grabstein, Guild-Kanäle liefert der Server ohne
 * gelöschte Nachrichten aus.
 *
 * **Grenze.** Höchstens `GRABSTEINE_JE_KANAL` je Kanal, der älteste fällt zuerst.
 * Ohne Grenze wüchse die Menge in einem tagelang offenen Kanal mit jeder
 * Löschung weiter (die Liste selbst ist auf `CAP` = 5000 gedeckelt, die
 * Grabsteine daneben nicht). 1000 deckt auch ein größeres Aufräumen von Hand
 * ab; wer in einer Sitzung mehr löscht, behält die jüngsten 1000 — die
 * Wiederkehr einer eben gelöschten Nachricht ist wahrscheinlicher als die
 * einer, die Stunden zurückliegt.
 * Kosten: gemessen (V8, 19-stellige Ids) rund 60 Bytes je Eintrag, also etwa
 * 60 kB je Kanal, bei 15 Kanälen im Cache also unter 1 MB im Höchstfall.
 *
 * Importfrei (s. CLAUDE.md, `pnpm test:unit`-Falle).
 */

export const GRABSTEINE_JE_KANAL = 1000;

/**
 * Vermerkt `kryptoId` als gelöscht: in `krypto` (dort prüft die
 * Dublettenabwehr) und in `begraben` (dort überlebt sie den Abgleich). Wird
 * die Grenze überschritten, fällt der älteste Grabstein aus BEIDEN Mengen;
 * ein erneut gesetzter rückt ans junge Ende. Ändert beide Mengen an Ort und
 * Stelle.
 */
export function grabsteinSetzen(
  krypto: Set<string>,
  begraben: Set<string>,
  kryptoId: string
): void {
  krypto.add(kryptoId);
  begraben.delete(kryptoId);
  begraben.add(kryptoId);
  if (begraben.size <= GRABSTEINE_JE_KANAL) return;
  const aeltester = begraben.values().next().value;
  if (aeltester === undefined) return;
  begraben.delete(aeltester);
  krypto.delete(aeltester);
}

/** Die Grabsteine aller Kanäle des Stores. Nicht reaktiv — angezeigt wird
 *  davon nichts. */
export class Grabsteine {
  private readonly je = new Map<string, Set<string>>();

  /** Die Grabsteine eines Kanals; legt die (leere) Menge an, wenn es noch
   *  keine gibt. */
  fuer(kanalId: string): Set<string> {
    let menge = this.je.get(kanalId);
    if (!menge) {
      menge = new Set();
      this.je.set(kanalId, menge);
    }
    return menge;
  }

  vergessen(kanalId: string): void {
    this.je.delete(kanalId);
  }

  leeren(): void {
    this.je.clear();
  }
}
