/**
 * Webcam-Aufnahme: Auflösung und Bildrate aus der Obergrenze der Instanz
 * (`capabilities.camResolutionMax` / `camFpsMax`). Importfrei, damit
 * `pnpm test:unit` die Rechnung direkt prüfen kann
 * (`test/kamera-aufloesung.test.ts`).
 */

/** Static camera resolution map — width/height only; frameRate is dynamic and
 *  added at call-site from capabilities.camFpsMax. */
const CAM_DIMS: Record<string, { width: number; height: number }> = {
  '1440p': { width: 2560, height: 1440 },
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 }
};

/** Unbekannte Stufe → 720p; Bildrate 0/fehlend → 30, sonst auf 1..60 begrenzt. */
export function kameraAufloesung(
  aufloesungMax: string,
  fpsMax: number
): { width: number; height: number; frameRate: number } {
  const d = CAM_DIMS[aufloesungMax] ?? CAM_DIMS['720p'];
  const frameRate = Math.min(Math.max(fpsMax || 30, 1), 60);
  return { width: d.width, height: d.height, frameRate };
}
