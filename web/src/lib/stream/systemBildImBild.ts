/**
 * System-Bild-in-Bild für ein `<video>` der Web-App — das Fenster des
 * Betriebssystems, das über anderen Apps stehen bleibt (iOS-Roadmap Punkt 29).
 * Das Web-Eckfenster (`watch/WatchBackgroundFrame.svelte`) kann das nicht: es
 * lebt im Dokument und verschwindet mit der App.
 *
 * **Importfrei**, damit Nodes Läufer die Datei ohne Bundler prüfen kann
 * (`test/system-bild-im-bild.test.ts`); Dokument und Video kommen als
 * Parameter herein.
 *
 * **Zwei Wege, und es entscheidet die FÄHIGKEIT, nicht die Plattform.**
 * WebKit kennt die Standard-Schnittstelle (`requestPictureInPicture`) und
 * daneben seine eigene (`webkitSetPresentationMode`). Der Standardweg hat den
 * Vorzug: er meldet ein Scheitern als abgelehntes Versprechen. Der
 * WebKit-Weg meldet nichts — er kippt den Modus und fällt nach rund 5 s
 * still zurück, wenn das System ablehnt (im Simulator am 2026-10-11 so
 * gesehen: `failedToEnterPictureInPicture` im Gerätelog, im Dokument nur
 * zwei `webkitpresentationmodechanged`).
 *
 * **Was der Simulator dazu sagt, und was nicht.** Im iPhone-Simulator (iOS
 * 26.3) sind beide Abfragen `false` — in der Hülle UND in Safari, für einen
 * `MediaStream` wie für eine Videodatei: das Profil des simulierten iPhones
 * schaltet Bild-in-Bild ab (`PiPOverlay = 0`, `AVPictureInPictureController.
 * isPictureInPictureSupported()` ist dort `false`). Ob WebKit am Telefon ein
 * Video mit WHEP-`MediaStream` ins System-Bild-in-Bild lässt, ist damit NICHT
 * belegt — nur, dass der Knopf ohne die Fähigkeit nicht erscheint.
 */

/** Was hier von einem `<video>` gebraucht wird — WebKits Zusätze optional. */
export interface BildImBildVideo {
  disablePictureInPicture?: boolean;
  requestPictureInPicture?: () => Promise<unknown>;
  webkitSupportsPresentationMode?: (modus: string) => boolean;
  webkitSetPresentationMode?: (modus: string) => void;
  webkitPresentationMode?: string;
}

/** Was hier vom `document` gebraucht wird. */
export interface BildImBildDokument {
  pictureInPictureEnabled?: boolean;
  pictureInPictureElement?: unknown;
  exitPictureInPicture?: () => Promise<void>;
}

export type BildImBildWeg = 'standard' | 'webkit';

const PIP = 'picture-in-picture';

/** Welcher Weg trägt für dieses Video — `null`, wenn keiner. */
export function bildImBildWeg(
  video: BildImBildVideo | null,
  doc: BildImBildDokument
): BildImBildWeg | null {
  if (!video || video.disablePictureInPicture) return null;
  if (doc.pictureInPictureEnabled === true && typeof video.requestPictureInPicture === 'function') {
    return 'standard';
  }
  if (
    typeof video.webkitSetPresentationMode === 'function' &&
    video.webkitSupportsPresentationMode?.(PIP) === true
  ) {
    return 'webkit';
  }
  return null;
}

/** Steht dieses Video gerade im System-Bild-in-Bild? */
export function bildImBildAktiv(video: BildImBildVideo | null, doc: BildImBildDokument): boolean {
  if (!video) return false;
  return doc.pictureInPictureElement === video || video.webkitPresentationMode === PIP;
}

export type BildImBildErgebnis =
  | { ergebnis: 'an' | 'aus' | 'kein-weg' }
  | { ergebnis: 'fehler'; grund: string };

/**
 * Ins Bild-in-Bild oder zurück. **Aus dem Klick heraus rufen, ohne vorheriges
 * `await`:** beide Wege verlangen eine Nutzergeste, und jedes Warten davor
 * kann sie verbrauchen.
 *
 * `'fehler'` heisst: das System hat abgelehnt, `grund` sagt warum. Der
 * WebKit-Weg kann das nicht melden (s. Kopf) — dort steht `'an'` für
 * „angefordert", nicht für „offen".
 */
export async function bildImBildUmschalten(
  video: BildImBildVideo,
  doc: BildImBildDokument
): Promise<BildImBildErgebnis> {
  try {
    if (bildImBildAktiv(video, doc)) {
      if (doc.pictureInPictureElement === video && doc.exitPictureInPicture) {
        await doc.exitPictureInPicture();
      } else {
        video.webkitSetPresentationMode?.('inline');
      }
      return { ergebnis: 'aus' };
    }
    const weg = bildImBildWeg(video, doc);
    if (weg === 'standard') {
      await video.requestPictureInPicture!();
      return { ergebnis: 'an' };
    }
    if (weg === 'webkit') {
      video.webkitSetPresentationMode!(PIP);
      return { ergebnis: 'an' };
    }
    return { ergebnis: 'kein-weg' };
  } catch (e) {
    const grund = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ergebnis: 'fehler', grund };
  }
}

/**
 * Die Ereignisse, nach denen Weg und Zustand neu zu lesen sind. WebKit
 * beantwortet die Fähigkeit erst sicher, wenn das Video Metadaten hat; ein
 * neuer Strom (`emptied`) kann sie ändern.
 */
export const BILD_IM_BILD_EREIGNISSE = [
  'loadedmetadata',
  'emptied',
  'enterpictureinpicture',
  'leavepictureinpicture',
  'webkitpresentationmodechanged'
] as const;
