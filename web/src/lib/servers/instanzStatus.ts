/**
 * Was ein `instance_status`-Ereignis der Cloud am Server-Eintrag ändern darf —
 * reine Rechnung, importfrei (prüfbar mit `pnpm test:unit`, Muster wie
 * `anzeige.ts`). Der Handler (`ws/handlers/instanzen.ts`) führt das Ergebnis
 * nur noch aus.
 *
 * **Warum „online“ nur für Heim-Server zählt.** Bis 2026-10-12 wertete der
 * Handler jedes `online: false` als „Server gestoppt“: Eintrag auf offline,
 * Anwesenheit „schläft“, und wer gerade auf diesem Server war, wurde auf die
 * Cloud zurückgesetzt. Die Cloud schickte `false` aber auch für einen per
 * Gerätecode verbundenen Server (`origin: 'vps'`), der sich gar nicht beim
 * Telefonbuch meldet — dort ist `false` bloß der Vorgabewert der Spalte. Der
 * Betreiber, der seinen Server umbenannte, flog damit im selben Moment von ihm
 * hinunter, und jedes Mitglied, das gerade darauf war, mit ihm. Deshalb zählt
 * die Meldung nur dort, wo sie gemessen wurde (`app_host`) — und nur als
 * ausdrücklicher Wahrheitswert. Dieselbe Regel steht in `anzeige.ts` für die
 * Sichtbarkeit; ältere Clouds, die für VPS noch `false` senden, werden damit
 * ebenfalls ignoriert.
 *
 * Der Name dagegen gilt immer: das Ereignis trägt stets den aktuellen Stand
 * (leer = zurückgesetzt).
 */

export interface StatusEintrag {
  origin?: 'vps' | 'app_host' | null;
}

export interface StatusEreignis {
  online?: boolean | null;
  anzeigename?: string | null;
}

export interface StatusWirkung {
  /** Für `serversStore.setzeInstanzStatus`; `online` fehlt = nicht anfassen. */
  stand: { online?: boolean; anzeigename: string | null };
  /** Für `appHostAnwesenheit.vermerke(id, offline)`; `null` = nichts vermerken. */
  offline: boolean | null;
  /** Der Server ist weg, während man auf ihm ist → zurück zur Cloud. */
  zurueckZurCloud: boolean;
}

export function wirkungVonStatus(
  eintrag: StatusEintrag,
  evt: StatusEreignis,
  istAktiv: boolean,
): StatusWirkung {
  const gemessen = eintrag.origin === 'app_host' && typeof evt.online === 'boolean';
  const online = gemessen ? (evt.online as boolean) : undefined;
  return {
    stand: {
      ...(online === undefined ? {} : { online }),
      anzeigename: evt.anzeigename ?? null,
    },
    offline: online === undefined ? null : !online,
    zurueckZurCloud: online === false && istAktiv,
  };
}
