/**
 * HQ-Stream-Ton in der iOS-Hülle sofort hörbar machen — die reine Rechnung
 * neben `hqStreamManager.svelte.ts`. **Importfrei** (Pflicht für
 * `pnpm test:unit`, s. CLAUDE.md).
 *
 * **Warum die Hülle das darf.** Capacitor 8.5.2 setzt an der WKWebView
 * `mediaTypesRequiringUserActionForPlayback = []` und
 * `allowsInlineMediaPlayback = true` (`CAPBridgeViewController.swift`,
 * `webViewConfiguration(for:)`, im Paket nachgelesen; die Hülle pinnt
 * `capacitor-swift-pm` seit ihrem ersten Bau auf genau 8.5.2). Damit verlangt
 * WebKit für Ton keine Nutzergeste — dass das auch `AudioContext.resume()`
 * einschliesst (WebKits `audioPlaybackRequiresUserGesture` steuert beide), ist
 * **aus WebKits Aufbau gefolgert, nicht am Gerät gemessen**.
 *
 * Deshalb kein Vertrauen, sondern ein Versuch: der Kontext wird ohne Geste
 * fortgesetzt, und nur wenn er danach immer noch steht, zeigt die Kachel
 * „Ton aktivieren" (Rückfall, etwa wenn WebKit den Kontext als `interrupted`
 * führt). Vorher stand der Knopf in der Hülle bei jedem Öffnen.
 */

/** So lange darf `resume()` offen bleiben, bevor es als gescheitert gilt —
 *  WebKit lässt es bei einem unterbrochenen Kontext offen. Gesetzt, nicht
 *  gemessen. */
export const FORTSETZEN_FRIST_MS = 1500;

export interface FortsetzbarerTon {
  resume(): Promise<void>;
  readonly suspended: boolean;
}

/** Ohne Geste fortsetzen; `true`, wenn der Ton danach läuft. */
export async function ohneGesteFortsetzen(
  ton: FortsetzbarerTon,
  fristMs: number = FORTSETZEN_FRIST_MS
): Promise<boolean> {
  if (!ton.suspended) return true;
  let uhr: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    ton.resume().catch(() => undefined),
    new Promise<void>((r) => (uhr = setTimeout(r, fristMs)))
  ]);
  clearTimeout(uhr);
  return !ton.suspended;
}

/**
 * Gespeicherte Lautstärken ohne die Nullen. Bis zum 2026-10-17 speicherte
 * „Pause" im Kontrollzentrum oder auf dem Sperrbildschirm die Lautstärke 0 —
 * der Stream blieb danach bei jedem Öffnen stumm. Eine gespeicherte 0 lässt
 * sich von einem bewussten Stummschalten in der Kachel nicht unterscheiden;
 * die Hülle räumt sie deshalb EINMAL weg (`streamVolume.ts`).
 */
export function ohneNullen(werte: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(werte).filter(([, v]) => v !== 0));
}
