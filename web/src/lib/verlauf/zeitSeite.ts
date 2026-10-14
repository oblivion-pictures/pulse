/**
 * Blättern im lokalen Verlauf nach der ZEIT, nicht nach dem rohen Schlüssel
 * (Gegenprüfung 2026-10-14, V2). Der Primärschlüssel (`satz.ts::
 * sortierSchluessel`) polstert die ID auf 20 Stellen und sortiert damit nach
 * der Zahl — und die Zahl ordnet die drei ID-Formen nicht nach der Zeit: eine
 * Server-Snowflake hat heute 18 Stellen, eine lokale ID 19 (bis 2026-09-02
 * 20, `utils/snowflakeZeit.ts`). Jede lokale ID lag damit über jeder
 * Snowflake, gleich wann sie entstand. Auf einem Frischgerät, das alles aus
 * dem Archiv holt (eigene Zeilen unter der lokalen ID, fremde unter der
 * Zeilen-ID des Servers), zeigte die erste Seite nur die eigenen
 * Nachrichten, und beim Hochscrollen kamen die fremden als Block davor.
 * Dasselbe galt schon vorher für Zustellungs-IDs (18 Stellen) neben eigenen.
 *
 * **Ohne neuen Index.** Jede ID-Form belegt einen eigenen, zusammenhängenden
 * Zahlenbereich (`BEREICHE`), und INNERHALB eines Bereichs ordnet die Zahl
 * genau wie `vergleicheSnowflakeArtigeId` (erst die eingebettete Zeit, dann
 * die rohe Zahl). Die neuesten `anzahl` Sätze vor einer Grenze liegen deshalb
 * unter den je `anzahl` neuesten jedes Bereichs: drei begrenzte
 * Bereichs-Cursor, danach in JS nach der Zeit gemischt. Ein Index über die
 * Zeit bräuchte eine höhere `DB_VERSION`, und an genau der hängt die Gefahr
 * alter Tabs (`schema.ts`, Kommentar zu `DB_VERSION`).
 *
 * Die Grenze trägt bis Juli 2033: dann erreichen Snowflakes 19 Stellen und
 * `vergleicheSnowflakeArtigeId` selbst verliert die Unterscheidung (Kopf von
 * `zeitOderNull`) — dieser Leser erbt die Grenze, er schafft keine neue.
 *
 * Importfrei bis auf den `.ts`-Pfad (Nodes Testläufer).
 */
import {
  SNOWFLAKE_EPOCH_MS,
  SNOWFLAKE_ZEIT_SHIFT,
  vergleicheSnowflakeArtigeId,
  zeitOderNull
} from '../utils/snowflakeZeit.ts';

type Bereich = {
  min: bigint;
  max: bigint;
  /** Die kleinste ID dieses Bereichs mit eingebetteter Zeit ≥ `ms`. */
  kleinsteId: (ms: bigint) => bigint;
};

const BEREICHE: readonly Bereich[] = [
  // Server-Snowflakes (bis 18 Stellen): Zeit in den oberen Bits.
  {
    min: 1n,
    max: 10n ** 18n - 1n,
    kleinsteId: (ms) => (ms - SNOWFLAKE_EPOCH_MS) << SNOWFLAKE_ZEIT_SHIFT
  },
  // Lokale ID, 19 Stellen: die ersten 13 sind `Date.now()`.
  { min: 10n ** 18n, max: 10n ** 19n - 1n, kleinsteId: (ms) => ms * 10n ** 6n },
  // Lokale ID, 20 Stellen (Altbestand bis 2026-09-02).
  { min: 10n ** 19n, max: 10n ** 20n - 1n, kleinsteId: (ms) => ms * 10n ** 7n }
];

/** Ein Bereich in Nachrichten-IDs, für `IDBKeyRange.bound` über
 *  `sortierSchluessel` (untere Grenze eingeschlossen). */
export type ZeitBereich = { von: string; bis: string; bisOffen: boolean };

const ZIFFERN = /^[1-9][0-9]*$/;

/** Die obere Grenze eines Bereichs für „vor `vor`" im Sinne von
 *  `vergleicheSnowflakeArtigeId`, oder `null`, wenn dort nichts davor liegt. */
function obereGrenze(b: Bereich, vor: string | undefined): { wert: bigint; offen: boolean } | null {
  if (vor === undefined) return { wert: b.max, offen: false };
  const zahl = ZIFFERN.test(vor) ? BigInt(vor) : null;
  if (zahl !== null && zahl >= b.min && zahl <= b.max) return { wert: zahl, offen: true };
  const ms = zeitOderNull(vor);
  // Ein unbekanntes Schema sortiert der Vergleich hinter alles.
  if (ms === null) return { wert: b.max, offen: false };
  // Bei gleicher Millisekunde steht ein Satz dieses Bereichs vor `vor`, wenn
  // seine Zahl kleiner ist (der Bereich liegt ganz darunter) oder `vor` die
  // vorläufige `tmp-`-Form hat (die sortiert hinter jede bestätigte).
  const gleicheMsDavor = zahl === null || b.max < zahl;
  const grenze = b.kleinsteId(gleicheMsDavor ? ms + 1n : ms);
  if (grenze <= b.min) return null;
  if (grenze > b.max) return { wert: b.max, offen: false };
  return { wert: grenze, offen: true };
}

/** Die Bereiche, in denen die Sätze vor `vor` liegen (ohne `vor`: alle). */
export function zeitBereiche(vor?: string): ZeitBereich[] {
  const aus: ZeitBereich[] = [];
  for (const b of BEREICHE) {
    const grenze = obereGrenze(b, vor);
    if (grenze !== null) {
      aus.push({ von: String(b.min), bis: String(grenze.wert), bisOffen: grenze.offen });
    }
  }
  return aus;
}

/** Der `before`-Anker für `listMessages` zu „vor `vor`“, oder `null`, wenn
 *  beim Server nichts davor liegen kann (Gegenprüfung 2026-10-14, W1).
 *
 *  **Der Server braucht eine Snowflake.** Er vergleicht `before` als Zahl
 *  (`routes/messages.py`: `Message.id < before`, höchstens 2^63−1). Die
 *  älteste angezeigte Nachricht ist aber oft eine eigene verschlüsselte mit
 *  lokaler ID: 19 Stellen liegen numerisch über jeder Snowflake (der Server
 *  lieferte die NEUESTE Seite des Kanals statt der älteren), 20 Stellen
 *  liegen über 2^63−1 (422, das Hochscrollen brach mit Ladefehler ab), `tmp-`
 *  ist keine Zahl. Die Grenze kommt deshalb aus derselben Rechnung wie die
 *  lokale Seite: die obere Grenze des Snowflake-Bereichs für „vor `vor`“ in
 *  der Zeit. Für eine Snowflake ist das `vor` selbst, für alles andere die
 *  erste Snowflake ab der Millisekunde danach (gleiche Millisekunde sortiert
 *  der Vergleich vor die lokale ID). Lokale und Serverseite meinen damit
 *  dasselbe Fenster. */
export function serverAnker(vor: string): string | null {
  const grenze = obereGrenze(BEREICHE[0], vor);
  if (grenze === null) return null;
  return String(grenze.offen ? grenze.wert : grenze.wert + 1n);
}

/** Mischt die Treffer der Bereiche: die `anzahl` neuesten nach der Zeit,
 *  älteste zuerst — die Reihenfolge, die `MessageStore` erwartet. */
export function neuesteNachZeit<S extends { nachrichtId: string }>(
  kandidaten: S[],
  anzahl: number
): S[] {
  const sortiert = [...kandidaten].sort((a, b) =>
    vergleicheSnowflakeArtigeId(a.nachrichtId, b.nachrichtId)
  );
  return sortiert.slice(Math.max(0, sortiert.length - anzahl));
}
