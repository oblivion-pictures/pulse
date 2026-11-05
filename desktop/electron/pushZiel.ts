/**
 * Welche Push-Ziele ein `start` aus dem Renderer mitbringen darf.
 *
 * **Warum es das gibt** (Gegenprüfung des Security-Audits, 2026-11-05): die
 * Sidecars nehmen `channel.push_url` wörtlich. Ein Schema, das sie nicht
 * kennen (`url_format_hint` in den Sidecars), geht an FFmpegs
 * `format::output()` — ein lokaler Pfad wird damit als Datei geschrieben
 * (Muxer nach Dateiendung), `tcp://`/`udp://` streamt an ein beliebiges
 * Ziel. Der Renderer ist die remote geladene Web-App; eine XSS-Lücke dort
 * hätte so Nutzerdateien überschreiben oder den Bildschirm ausleiten können.
 * Echte Ziele kommen von media-svc: WHIP (`https://…/whip`, im lokalen
 * Dev-Stack `http://`), RTMP(S) und SRT. Die Prüfung steht hier und nicht im
 * Sidecar, weil Testaufbauten den Sidecar ausdrücklich in Dateien schreiben
 * lassen — und weil hier jede Anfrage des Renderers durchkommt.
 *
 * Importfrei (Nodes Testläufer, `desktop/test/push-ziel.test.ts`).
 */

const ERLAUBTE_SCHEMATA = new Set(['https:', 'http:', 'rtmps:', 'rtmp:', 'srt:']);

/** `true`: die `start`-Parameter tragen kein `push_url` oder eines mit einem
 *  erlaubten Schema. Ohne `push_url` baut der Sidecar das Ziel selbst. */
export function pushZielErlaubt(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return true;
  const kanal = (params as { channel?: unknown }).channel;
  if (typeof kanal !== 'object' || kanal === null) return true;
  const ziel = (kanal as { push_url?: unknown }).push_url;
  if (ziel === undefined || ziel === null) return true;
  if (typeof ziel !== 'string') return false;
  try {
    return ERLAUBTE_SCHEMATA.has(new URL(ziel).protocol);
  } catch {
    return false;
  }
}
