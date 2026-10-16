/**
 * Sitzt jemand vor der App? — die Aktivitäts-Uhr für die Lesestand-Meldung.
 *
 * `hinschauen.ts` sagt nur „sichtbar und fokussiert". Das gilt auch für ein
 * Fenster, vor dem niemand sitzt: Pulse steht am Rechner auf einer DM offen,
 * der Nutzer ist mit dem Handy weg. Der Server hält DM-Pushes ans Handy einige
 * Sekunden zurück und verwirft sie, wenn die Nachricht in der Zeit gelesen
 * wurde (`fcm_gelesen.py`) — ohne diese Uhr verschwände der Banner am Handy
 * genau dann, wenn er gebraucht wird (Gegenprüfung 2026-10-17, P1).
 *
 * Deshalb meldet `api/lesestand.ts` einen Stand nur dann als `aktiv`, wenn in
 * den letzten {@link AKTIV_FENSTER_MS} eine echte Eingabe auf der Seite war.
 * Am Lesestand selbst, an Häkchen und Zählern ändert das nichts — es geht nur
 * um die Frage, ob der Server einen Push verwerfen darf. Im Zweifel nicht.
 *
 * Nicht erfasst: Eingaben in anderen Programmen. Electrons
 * `powerMonitor.getSystemIdleTime()` wüsste mehr, ist aber über die Brücke
 * zum Renderer nicht erreichbar — das bräuchte ein Desktop-Release.
 *
 * Importfrei (s. CLAUDE.md, die `pnpm test:unit`-Falle).
 */

/** So lange nach der letzten Eingabe gilt der Nutzer als anwesend. */
export const AKTIV_FENSTER_MS = 60_000;

/** Was als Eingabe zählt: Tastatur, Maus, Touch, Scrollen. */
export const EINGABE_EREIGNISSE = [
  'keydown',
  'pointerdown',
  'pointermove',
  'touchstart',
  'wheel',
  'scroll'
] as const;

export interface AktivitaetsUhr {
  /** Eine Eingabe ist eben passiert. */
  eingabe(): void;
  /** Gab es in den letzten `fensterMs` eine Eingabe? */
  istAktiv(fensterMs?: number): boolean;
}

export function aktivitaetsUhr(jetzt: () => number = Date.now): AktivitaetsUhr {
  let letzte: number | null = null;
  return {
    eingabe() {
      letzte = jetzt();
    },
    istAktiv(fensterMs = AKTIV_FENSTER_MS) {
      return letzte !== null && jetzt() - letzte <= fensterMs;
    }
  };
}

interface Ereignisziel {
  addEventListener(
    art: string,
    rueckruf: (e: { isTrusted?: boolean }) => void,
    optionen?: { passive?: boolean; capture?: boolean }
  ): void;
}

/** Hängt die Uhr an die Eingabe-Ereignisse von `ziel` (im Browser `window`;
 *  `capture`, damit auch `scroll` ankommt, das nicht hochblubbert). Nur echte
 *  Eingaben zählen — ein per Skript ausgelöstes Ereignis (`isTrusted: false`)
 *  ist keine Anwesenheit. */
export function beobachten(ziel: Ereignisziel, uhr: AktivitaetsUhr): void {
  const merken = (e: { isTrusted?: boolean }) => {
    if (e.isTrusted !== false) uhr.eingabe();
  };
  for (const art of EINGABE_EREIGNISSE) {
    ziel.addEventListener(art, merken, { passive: true, capture: true });
  }
}
