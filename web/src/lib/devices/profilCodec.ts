/**
 * Codec des Standplatz-Profils: was angeboten wird und was ein gespeicherter
 * Wert auf DIESER Karte wird.
 *
 * **Warum es das gibt.** Das Profil entstand am 2026-08-16 mit H.264 und AV1;
 * HEVC kam am 2026-09-13 in die normalen Stream-Einstellungen und wurde hier
 * nicht mitgezogen. Zugleich bot das Profil AV1 auf jeder Karte an — auch
 * dort, wo der Encoder es nicht kann (2026-10-14: RTX 3060 Ti, die HEVC
 * kann, aber kein AV1). Das normale Codec-Feld filtert längst nach der
 * Encoder-Probe (`OverridesEditor.svelte`) und stuft einen gespeicherten Codec
 * herab (`codecAnpassungFuerGpu`); hier gilt jetzt dieselbe Regel.
 *
 * **Importfrei** (s. `pnpm test:unit`-Falle in `CLAUDE.md`). Was die Karte
 * kann, reicht der Aufrufer herein (`kartenFaehigkeit.ts`); `undefined` heisst
 * „noch nicht gemessen".
 */

export type ProfilCodec = 'h264' | 'hevc' | 'av1';

export interface KartenFaehigkeit {
  hasAv1: boolean;
  hasHevc: boolean;
}

export const PROFIL_CODECS: ReadonlyArray<{ value: ProfilCodec; label: string }> = [
  { value: 'h264', label: 'H.264' },
  { value: 'hevc', label: 'HEVC' },
  { value: 'av1', label: 'AV1' },
];

export function istProfilCodec(wert: unknown): wert is ProfilCodec {
  return wert === 'h264' || wert === 'hevc' || wert === 'av1';
}

/**
 * Nur anbieten, was die Karte encodieren kann; H.264 steht immer da.
 *
 * Ungemessen bleibt alles stehen: eine fehlende Antwort ist keine Unfähigkeit,
 * und ein Formular, das HEVC und AV1 versteckt, bis jemand den Stream-Dialog
 * geöffnet hat, böte genau die gesuchte Wahl nicht an.
 */
export function profilCodecOptionen(karte: KartenFaehigkeit | undefined): ProfilCodec[] {
  return PROFIL_CODECS.map((c) => c.value).filter(
    (c) => !karte || c === 'h264' || (c === 'hevc' ? karte.hasHevc : karte.hasAv1),
  );
}

/**
 * Der gespeicherte Codec, wie er auf dieser Karte gesendet wird.
 *
 * Herabgestuft nach derselben Staffel wie `codecVorgabeFuerGpu` (AV1 vor HEVC
 * vor H.264): ein AV1-Profil auf einer Karte ohne AV1 sendet HEVC, wenn sie das
 * kann. Auf einem Rechner, vor dem niemand sitzt, liefe ein nicht einlösbarer
 * Codec sonst wortlos ins Leere. Ungemessen bleibt der Wert, wie er ist.
 */
export function profilCodecFuerKarte(
  codec: ProfilCodec,
  karte: KartenFaehigkeit | undefined,
): ProfilCodec {
  if (!karte) return codec;
  if (codec === 'av1' && !karte.hasAv1) return karte.hasHevc ? 'hevc' : 'h264';
  if (codec === 'hevc' && !karte.hasHevc) return karte.hasAv1 ? 'av1' : 'h264';
  return codec;
}

/** HDR geht nur mit AV1 hinaus — der eine Ort für diese Regel (Weckruf und
 *  Zusammenfassung lesen sie hier). */
export function hdrGilt(codec: ProfilCodec, hdr: boolean): boolean {
  return hdr && codec === 'av1';
}

/**
 * Welche Farb-Schalter zum Codec passen: 10 bit gibt es mit AV1 oder HEVC, je
 * nachdem, was der Sidecar für den Codec meldet; HDR nur mit AV1 obendrauf
 * (`VIDEO_MODES` kennt keinen HEVC-HDR-Weg). Die Erfüllbarkeit beim Wecken
 * prüft `buildStartArgs` noch einmal — das hier entscheidet nur, was das
 * Formular anklickbar macht.
 */
export function farbSchalter(
  codec: ProfilCodec,
  f: { tenBitAvailable: boolean; hevcTenBitAvailable: boolean; hdrAvailable: boolean },
): { zehnBit: boolean; hdr: boolean } {
  const zehnBit =
    (codec === 'av1' && f.tenBitAvailable) || (codec === 'hevc' && f.hevcTenBitAvailable);
  return { zehnBit, hdr: codec === 'av1' && zehnBit && f.hdrAvailable };
}
