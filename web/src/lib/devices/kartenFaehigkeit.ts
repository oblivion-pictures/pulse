/**
 * Was die Grafikkarte DIESES Rechners encodieren kann — für das
 * Standplatz-Profil (`profilCodec.ts`).
 *
 * Die Antwort stammt aus der Encoder-Probe des Sidecars (`gpuInfo`,
 * `video_codecs`), dieselbe Quelle wie beim normalen Codec-Feld. Gefüllt wird
 * sie sonst nur von `loadCatalogs()` (Stream-Dialog) — das Profil-Formular und
 * ein geweckter Rechner sahen sie deshalb oft gar nicht. `sicherstellen` holt
 * sie gezielt nach, ohne den ganzen Katalog samt Vorgaben zu laden.
 */

import { sidecar } from '$lib/stream/sidecar';
import { streamSettings } from '$lib/stream/settingsState.svelte';
import { av1Nutzbar } from '$lib/stream/settings.svelte';
import { gpuHasHevc } from '$lib/stream/settingsCatalog';
import type { KartenFaehigkeit } from './profilCodec';

/** `undefined` = noch nicht gemessen. Liest `$state` — in `$derived` reaktiv. */
export function kartenFaehigkeit(): KartenFaehigkeit | undefined {
  const codecs = streamSettings.gpu_info?.video_codecs;
  if (!Array.isArray(codecs)) return undefined;
  return { hasAv1: av1Nutzbar(codecs), hasHevc: gpuHasHevc(codecs) };
}

/** Die Probe fahren, solange keine definitive Antwort vorliegt. Wirft nicht.
 *
 *  „Definitiv" heisst: `video_codecs` ist da. Der Linux-Sidecar lässt das Feld
 *  weg, solange seine Probe kein Ergebnis hat (`linux-hq-sidecar/src/caps.rs`)
 *  — eine solche Antwort darf nicht als „schon gefragt" zählen, sonst bliebe
 *  die Karte bis zum nächsten Stream-Dialog ungemessen. */
export async function kartenFaehigkeitSicherstellen(): Promise<void> {
  if (kartenFaehigkeit()) return;
  try {
    const antwort = await sidecar.gpuInfo();
    if (antwort?.ok) streamSettings.gpu_info = antwort;
  } catch {
    // Ohne Antwort bleibt es „ungemessen" — das Profil bietet dann alles an
    // und sendet, was gespeichert ist.
  }
}
