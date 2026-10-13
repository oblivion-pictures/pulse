/**
 * Die Grabsteine des Nachrichten-Stores (`stores/messages.svelte.ts`): die
 * Identität (Autor + Kennung, `verlauf/identitaet.ts`) jeder verschlüsselten
 * Nachricht, die aus einem Kanal gelöscht wurde,
 * solange dieser Kanal im Speicher steht — über Kappen UND über jedes erneute
 * Laden (`setInitial`) hinweg.
 *
 * **Wozu.** Dieselbe verschlüsselte Nachricht trägt auf jedem Gerät eine andere
 * lokale Id und ist nur an Autor und Kennung wiederzuerkennen
 * (`verlauf/identitaet.ts`). Der Store lässt die Identität einer gelöschten
 * Nachricht deshalb in der Dublettenmenge stehen: kommt später eine
 * Kopie unter anderer Id (Archiv- oder Sicherungs-Nachzug, Hochscrollen), gilt
 * sie als bekannt und erscheint nicht wieder. Der Verlauf-Merge
 * (`verlauf/zusammenfuegen.ts`) verdeckt eine solche Kopie nur, wenn Grabstein
 * und Kopie ihm gemeinsam vorgelegt werden — der Store füllt aber seitenweise
 * (`verlaufLesen` liefert ein Fenster), die beiden können in verschiedenen
 * Fenstern liegen. Das erneute Öffnen eines schon geladenen Kanals leert die
 * Liste und lädt sie neu (`setInitial`) und stößt unmittelbar danach den
 * Archiv- und Sicherungs-Nachzug an, also genau den Weg, der eine gelöschte
 * Nachricht wieder liefern kann.
 *
 * **Warum eine eigene Menge.** Die Dublettenmenge `identitaeten` ist ansonsten eine
 * Funktion der Liste (nur, was wirklich dort steht, `listenKern.ts::
 * mengenAbgleichen`) und wird beim Kappen aus ihr neu gebaut. Ein Grabstein
 * steht per Definition NICHT in der Liste; ohne eigenen Platz fiel er mit dem
 * Neuaufbau heraus. Hier steht er, der Abgleich spielt ihn danach zurück.
 *
 * **Lebensdauer.** Länger als die Dublettenmengen: ein erneutes Laden
 * (`setInitial`) baut `ids` und `identitaeten` aus der Liste neu, die
 * Grabsteine bleiben dabei stehen — `setInitial` nimmt sie in `identitaeten`
 * auf UND filtert die geladene Liste gegen sie (`listenKern.ts::
 * ohneGrabsteine`), ebenso weist `prepend` über `identitaeten` eine Seite mit
 * einer Kopie ab. Sie enden erst, wenn
 * der Kanal den Speicher verlässt (`clearChannel`: LRU-Deckel, nach einem
 * Verbindungsabriss eine Lücke über eine Seite hinaus, Kanal oder Community
 * fort) oder die Sitzung endet (`clear`). Ab dann ist der lokale Verlauf die
 * Quelle: für lokal geführte Kanäle (DM, private Gruppe) hält das
 * Grabstein-Register (`verlauf/grabsteinRegister.ts`) die gebundene Löschung
 * dauerhaft fest, und jeder Schreibweg legt eine spätere Kopie derselben
 * Identität als Grabstein ab; Guild-Kanäle liefert der Server ohne gelöschte
 * Nachrichten aus.
 *
 * **Autor-Bindung.** Ein Grabstein trägt Autor und Kennung, nie die Kennung
 * allein: die Kennung wählt der Absender frei. Bis 2026-10-13 standen hier
 * blosse `krypto_id`s, und löschte ein Gesprächspartner seine Nachricht, die er
 * unter der Kennung einer fremden geschickt hatte, verschwand die fremde mit.
 *
 * **Grenze.** Höchstens `GRABSTEINE_JE_KANAL` je Kanal, der älteste fällt zuerst.
 * Ohne Grenze wüchse die Menge in einem tagelang offenen Kanal mit jeder
 * Löschung weiter (die Liste selbst ist auf `CAP` = 5000 gedeckelt, die
 * Grabsteine daneben nicht). 1000 deckt auch ein größeres Aufräumen von Hand
 * ab; wer in einem Kanal mehr löscht, behält die jüngsten 1000 — die
 * Wiederkehr einer eben gelöschten Nachricht ist wahrscheinlicher als die
 * einer, die Stunden zurückliegt.
 * Kosten: gemessen (V8, 19-stellige Ids) rund 60 Bytes je Eintrag, also etwa
 * 60 kB je Kanal, bei 15 Kanälen im Cache also unter 1 MB im Höchstfall.
 *
 * Importfrei (s. CLAUDE.md, `pnpm test:unit`-Falle).
 */

export const GRABSTEINE_JE_KANAL = 1000;

/**
 * Vermerkt `identitaet` als gelöscht: in `identitaeten` (dort prüft die
 * Dublettenabwehr) und in `begraben` (dort überlebt sie den Abgleich). Wird
 * die Grenze überschritten, fällt der älteste Grabstein aus BEIDEN Mengen;
 * ein erneut gesetzter rückt ans junge Ende. Ändert beide Mengen an Ort und
 * Stelle.
 */
export function grabsteinSetzen(
  identitaeten: Set<string>,
  begraben: Set<string>,
  identitaet: string
): void {
  identitaeten.add(identitaet);
  begraben.delete(identitaet);
  begraben.add(identitaet);
  if (begraben.size <= GRABSTEINE_JE_KANAL) return;
  const aeltester = begraben.values().next().value;
  if (aeltester === undefined) return;
  begraben.delete(aeltester);
  identitaeten.delete(aeltester);
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
