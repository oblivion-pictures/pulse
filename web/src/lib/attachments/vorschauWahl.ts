/**
 * Entscheidung, ob ein erzeugtes Vorschaubild mit hochgeladen wird.
 *
 * Importfrei, damit `pnpm test:unit` sie ohne Bundler prüfen kann.
 *
 * Warum es diese Entscheidung gibt: `vorschaubild.ts` bittet den Browser per
 * `canvas.toBlob(…, 'image/webp', 0.85)` um ein WebP. Safari und jeder iOS-Browser
 * kodieren kein WebP; `toBlob` liefert dort STILL ein PNG (Spezifikation: ein
 * nicht unterstützter Typ fällt auf PNG zurück). Ein 720-px-PNG kann bis rund
 * 2,2 MB groß sein, ein WebP dagegen höchstens rund 0,9 MB. Ein solches Blob
 * unter dem Namen `image/webp` hochzuladen wäre falsch etikettiert und
 * verbrauchte ein Vielfaches an Kontingent; es steht deshalb nur dann im
 * Upload, wenn es wirklich ein WebP ist und die Grenze des Servers einhält.
 *
 * Wird es weggelassen, bleibt die Datei selbst unberührt: der Server kennt
 * Uploads ohne Vorschaubild (`has_thumb: false`, so laufen schon heute alle
 * Bilder, die der Browser nicht dekodieren kann), und die Oberfläche zeigt
 * dann das Original (`thumb_url ?? url`).
 */

/** Was der Server pro Vorschaubild annimmt — Spiegel von `MAX_THUMB_BYTES`
 *  (`routes/attachments.py`). Synchron halten. */
export const VORSCHAU_MAX_BYTES = 4 * 1024 * 1024;

/** Der Typ, unter dem der Server das Vorschaubild signiert (`image/webp`). */
export const VORSCHAU_TYP = 'image/webp';

/** Was der verschlüsselte Weg an das Blob hängt: 12 Byte IV + 16 Byte
 *  GCM-Siegel (`krypto/anhangKrypto.ts`). Die Grenze des Servers gilt für den
 *  Klumpen, nicht für das Blob. */
export const KLUMPEN_ZUSATZ_BYTES = 12 + 16;

/**
 * `true`, wenn das Vorschaubild hochgeladen werden soll.
 *
 * `typ`/`bytes` sind die des erzeugten Blobs; `zusatzBytes` ist, was auf dem
 * Weg zum Server noch dazukommt (verschlüsselter Weg: `KLUMPEN_ZUSATZ_BYTES`).
 * Ein anderer Typ als WebP heißt: der Browser hat den Wunsch nicht erfüllt.
 */
export function vorschauBehalten(typ: string, bytes: number, zusatzBytes = 0): boolean {
  return typ === VORSCHAU_TYP && bytes + zusatzBytes <= VORSCHAU_MAX_BYTES;
}
