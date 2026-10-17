/**
 * Hält der Browser das Cookie, das `POST /session/renew` setzt? Die reine
 * Entscheidung, importfrei (Pflicht für `pnpm test:unit`, s. CLAUDE.md) — die
 * Verdrahtung steht in `cookie-client.ts::renewSession`.
 *
 * **Vorfall 2026-10-17 (iOS-Hülle).** Ein Erneuern löste das Cookie ab, das
 * Set-Cookie kam nie im Cookie-Speicher an (Neuladen drei Sekunden danach).
 * Der Klient legte weiter das abgelöste Cookie vor; der Server antwortete
 * damals 204 ohne Cookie, `renewSession` hielt das für Erfolg, und der
 * Ticket-Abruf scheiterte 100-mal in acht Minuten mit 401. Der Server reicht
 * heute den Nachfolger nach und sagt das im Kopf `X-Pulse-Sitzung`
 * (`services/auth/src/dcc_auth/session_renew.py`, `KOPF`).
 *
 * Einmal „nachgereicht" ist harmlos — so endet auch das Rennen zweier Tabs,
 * die gleichzeitig erneuern, und das nachgereichte Cookie kommt an. Kommt es
 * mehrmals HINTEREINANDER, legt der Browser jedes Mal wieder das alte Cookie
 * vor: er behält das neue nicht. Dann hilft kein weiteres Erneuern, und
 * `renewSession` pausiert mit wachsendem Abstand, statt zu hämmern. Jede
 * Antwort mit einer neuen Sitzung hebt die Pause sofort auf.
 */

/** Antwortkopf des Servers — synchron mit `session_renew.KOPF`. */
export const ERNEUERUNGS_KOPF = 'X-Pulse-Sitzung';
/** Kopfwert, wenn der Server eine schon bestehende Sitzung noch einmal setzt. */
export const NACHGEREICHT = 'nachgereicht';
/** Ab so vielen „nachgereicht" in Folge gilt das Cookie als nicht gehalten. */
export const NACHGEREICHT_GRENZE = 2;
/** Pausen nach einem nicht gehaltenen Cookie; die letzte Stufe wiederholt sich. */
export const PAUSE_STUFEN_MS = [30_000, 60_000, 120_000, 300_000] as const;

export interface ErneuerungsStand {
  nachgereichtInFolge: number;
  /** Index in `PAUSE_STUFEN_MS` für die nächste Pause. */
  stufe: number;
  /** Bis wann nicht erneuert wird; `null` = keine Pause. */
  pauseBis: number | null;
}

export function neuerErneuerungsStand(): ErneuerungsStand {
  return { nachgereichtInFolge: 0, stufe: 0, pauseBis: null };
}

/** Darf jetzt erneuert werden? */
export function darfErneuern(stand: ErneuerungsStand, jetzt: number): boolean {
  return stand.pauseBis === null || stand.pauseBis <= jetzt;
}

/**
 * Eine erfolgreiche (2xx) Antwort einordnen. `kopf` = Wert von
 * `ERNEUERUNGS_KOPF` oder `null` (ältere Server ohne Kopf gelten wie „neu").
 * `haelt === false`: das Cookie kommt nicht an, `renewSession` meldet keinen
 * Erfolg. Verändert `stand`.
 */
export function nachErneuerung(
  stand: ErneuerungsStand,
  kopf: string | null,
  jetzt: number
): { haelt: boolean } {
  if (kopf !== NACHGEREICHT) {
    Object.assign(stand, neuerErneuerungsStand());
    return { haelt: true };
  }
  stand.nachgereichtInFolge += 1;
  if (stand.nachgereichtInFolge < NACHGEREICHT_GRENZE) return { haelt: true };
  // Der Zähler bleibt stehen: kommt nach der Pause wieder „nachgereicht",
  // folgt sofort die nächste, längere Pause.
  stand.pauseBis = jetzt + PAUSE_STUFEN_MS[stand.stufe];
  stand.stufe = Math.min(stand.stufe + 1, PAUSE_STUFEN_MS.length - 1);
  return { haelt: false };
}
