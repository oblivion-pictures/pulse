/**
 * Wann der Abgleich der Server-Liste (`serversStore.hydrateFromBackend`) nach
 * einem Fehlschlag wieder läuft — importfrei (s. `pnpm test:unit`-Falle in
 * CLAUDE.md).
 *
 * Erst nach festen Stufen (10 s, 30 s, 90 s; deckt ein Deploy-Fenster der
 * Cloud ab, Vorfall 2026-07-14). Sind die aufgebraucht, gab der Abgleich bis
 * 2026-10-17 still auf, bis zur nächsten Anmeldung. An dem Tag scheiterte in
 * der iOS-Hülle `GET /me/instances` mit 401 (totes Cloud-Cookie, s.
 * `api/cookieErneuerung.ts`) — die Liste wäre auch nach der Heilung des
 * Cookies so geblieben, und eine App wird selten neu angemeldet. Seither
 * wartet er nach der letzten Stufe auf das nächste Zeichen, dass sich etwas
 * geändert haben kann: die Seite wird wieder sichtbar (App aus dem
 * Hintergrund) oder der Browser meldet sich wieder online. Dann beginnt die
 * Kette von vorn. Kein Dauerabfragen: ohne ein solches Zeichen bleibt es still.
 */

export const ABGLEICH_STUFEN_MS = [10_000, 30_000, 90_000] as const;

export interface WiederholUmgebung {
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(griff: unknown): void;
  verdeckt(): boolean;
  /** Meldet Sichtbarkeitswechsel und Wieder-online; gibt die Abmeldung zurück. */
  beiRueckkehr(hoerer: () => void): () => void;
}

export interface AbgleichWiederholung {
  /** Nach dem Fehlschlag von Versuch `versuch` (0 = erster) den nächsten
   *  planen; `lauf` bekommt die Nummer des nächsten Versuchs. */
  planen(versuch: number, lauf: (naechster: number) => void): void;
  /** Geplantes verwerfen — ein frischer Abgleich ersetzt die Kette. */
  abbrechen(): void;
}

export function abgleichWiederholung(
  umgebung: WiederholUmgebung,
  stufenMs: readonly number[] = ABGLEICH_STUFEN_MS
): AbgleichWiederholung {
  let griff: unknown = null;
  let abmelden: (() => void) | null = null;

  const abbrechen = () => {
    if (griff !== null) umgebung.clearTimeout(griff);
    griff = null;
    abmelden?.();
    abmelden = null;
  };

  return {
    abbrechen,
    planen(versuch, lauf) {
      abbrechen();
      const warte = stufenMs[versuch];
      if (warte !== undefined) {
        griff = umgebung.setTimeout(() => {
          griff = null;
          lauf(versuch + 1);
        }, warte);
        return;
      }
      abmelden = umgebung.beiRueckkehr(() => {
        if (umgebung.verdeckt()) return;
        abbrechen();
        lauf(0);
      });
    }
  };
}

/** Die echte Umgebung: Fenster-Timer, `visibilitychange`, `online`. */
export function browserWiederholUmgebung(): WiederholUmgebung {
  const doc = typeof document === 'undefined' ? null : document;
  const win = typeof window === 'undefined' ? null : window;
  return {
    setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
    clearTimeout: (griff) => globalThis.clearTimeout(griff as ReturnType<typeof setTimeout>),
    verdeckt: () => doc?.hidden === true,
    beiRueckkehr(hoerer) {
      doc?.addEventListener('visibilitychange', hoerer);
      win?.addEventListener('online', hoerer);
      return () => {
        doc?.removeEventListener('visibilitychange', hoerer);
        win?.removeEventListener('online', hoerer);
      };
    }
  };
}
