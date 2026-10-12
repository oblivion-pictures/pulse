/**
 * Entscheidung, ob ein erzeugtes Vorschaubild mit hochgeladen wird.
 *
 * Importfrei, damit `pnpm test:unit` sie ohne Bundler prüfen kann.
 *
 * Warum es diese Entscheidung gibt: `vorschaubild.ts` bittet den Browser per
 * `canvas.toBlob(…, 'image/webp', 0.85)` um ein WebP. Safari und jeder iOS-Browser
 * kodieren kein WebP; `toBlob` liefert dort STILL ein PNG (Spezifikation: ein
 * nicht unterstützter Typ fällt auf PNG zurück). Ein 720-px-PNG kann bis rund
 * 2,2 MB groß sein, ein WebP dagegen höchstens rund 0,9 MB.
 *
 * **Ein solches PNG geht trotzdem mit, und das ist hingenommen, nicht
 * übersehen:** im Klartext-Weg läuft es unter dem Etikett `image/webp` (der
 * Server signiert die Upload-Adresse auf diesen Typ, der Klient setzt ihn beim
 * PUT) und verbraucht ein Mehrfaches des Kontingents eines WebP. So lief Safari
 * bis heute, und die Vorschaubilder wurden angezeigt; ob jeder Browser ein
 * falsch etikettiertes Bild darstellt, ist hier nicht eigens geprüft. Die
 * Alternative wäre, das Vorschaubild für jedes Safari-/iOS-Gerät wegzulassen; die
 * Zeitleiste lüde dann das Original (bis zur Dateigrenze, Vorgabe 25 MiB) statt
 * eines PNG von 1 bis 2 MB, und das ist für diese Nutzer schlechter als der
 * Kontingentverbrauch.
 *
 * Weggelassen wird, was die Grenze des Servers sprengt (sonst käme ein 413
 * und der ganze Upload bräche ab). Die feste Grenze (4 MiB) kennt der Klient;
 * die kleinere der Community (`min(4 MiB, Dateigrenze)`) nicht - dafür gibt es
 * `ticketAnfordern`, das nach einer Vorschaubild-Absage einmal ohne es neu fragt. Dann bleibt die Datei selbst unberührt: der
 * Server kennt Uploads ohne Vorschaubild (`has_thumb: false`, so laufen schon
 * heute alle Bilder, die der Browser nicht dekodieren kann), und die Oberfläche
 * zeigt das Original (`thumb_url ?? url`).
 */

/** Was der Server pro Vorschaubild annimmt — Spiegel von `MAX_THUMB_BYTES`
 *  (`routes/attachments.py`). Synchron halten. */
export const VORSCHAU_MAX_BYTES = 4 * 1024 * 1024;

/** Was der verschlüsselte Weg an das Blob hängt: 12 Byte IV + 16 Byte
 *  GCM-Siegel (`krypto/anhangKrypto.ts`). Die Grenze des Servers gilt für den
 *  Klumpen, nicht für das Blob. */
export const KLUMPEN_ZUSATZ_BYTES = 12 + 16;

/**
 * `true`, wenn das Vorschaubild hochgeladen werden soll: wenn es die Grenze des
 * Servers einhält - gleich ob WebP oder (Safari/iOS-Rückfall) PNG.
 *
 * `bytes` ist die Größe des erzeugten Blobs; `zusatzBytes` ist, was auf dem Weg
 * zum Server noch dazukommt (verschlüsselter Weg: `KLUMPEN_ZUSATZ_BYTES`).
 */
export function vorschauBehalten(bytes: number, zusatzBytes = 0): boolean {
  return bytes + zusatzBytes <= VORSCHAU_MAX_BYTES;
}

/** `detail` der 413, wenn NUR das Vorschaubild zu groß ist - Spiegel von
 *  `THUMB_TOO_LARGE_DETAIL` (`routes/attachments.py`). Synchron halten. Die
 *  Absage „Datei zu groß“ hat einen anderen Text (`file too large (…)`). */
export const VORSCHAU_ZU_GROSS = 'thumbnail too large';

/** Ist das die Absage „Vorschaubild zu groß“? Erwartet die Form von `ApiError`
 *  (`status`, `message` = `detail`); der Vergleich ist wörtlich und streng. */
export function istVorschauAbsage(fehler: unknown): boolean {
  if (typeof fehler !== 'object' || fehler === null) return false;
  const { status, message } = fehler as { status?: unknown; message?: unknown };
  return status === 413 && message === VORSCHAU_ZU_GROSS;
}

/**
 * Fordert das Upload-Ticket an und fällt EINMAL auf „ohne Vorschaubild“ zurück.
 *
 * Warum: die Grenze für das Vorschaubild ist `min(4 MiB, Dateigrenze der
 * Community)`, und die Dateigrenze kennt der Klient beim Hochladen nicht. In
 * einer Community mit kleiner Grenze (etwa 0,5 MB) liefert Safari ein
 * PNG-Vorschaubild darüber, der Server lehnt es ab, und ohne diesen Rückfall
 * bräche der ganze Upload ab, obwohl die Datei selbst passt.
 *
 * `anfordern(mitVorschau)` stellt das Ticket aus. Nur die Vorschaubild-Absage
 * (`istVorschauAbsage`) löst den Neuversuch aus - „Datei zu groß“ und jeder
 * andere Fehler gehen unverändert durch, denn ohne Vorschaubild änderte sich
 * nichts. Es gibt genau einen Neuversuch: scheitert er, geht sein Fehler durch.
 * Rückgabe: die Antwort und ob das Vorschaubild darin noch enthalten ist.
 */
export async function ticketAnfordern<T>(
  anfordern: (mitVorschau: boolean) => Promise<T>,
  mitVorschau: boolean
): Promise<{ antwort: T; mitVorschau: boolean }> {
  if (!mitVorschau) return { antwort: await anfordern(false), mitVorschau: false };
  try {
    return { antwort: await anfordern(true), mitVorschau: true };
  } catch (fehler) {
    if (!istVorschauAbsage(fehler)) throw fehler;
    return { antwort: await anfordern(false), mitVorschau: false };
  }
}
