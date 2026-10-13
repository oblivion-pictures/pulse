/**
 * Wann ist die Cloud-Sitzung (`pulse_session`-Cookie) belastbar? Die reine
 * Entscheidung dahinter, ohne Import (Pflicht für `pnpm test:unit`, s.
 * CLAUDE.md) — die Verdrahtung mit `renewSession()` und `fetch` steht in
 * `cookie-client.ts::mitCloudCookie`.
 *
 * **Warum es das gibt (Konsolen-401 auf `…/direct-endpoint`).** Das Cookie
 * trägt `Max-Age=1800` und bekommt es NUR beim Anmelden und bei
 * `POST /session/renew` (`browser_sessions.set_session_cookie`). Das
 * „gleitende Fenster" der Server-Seite (`validate_session`) verlängert allein
 * die Datenbankzeile, nie das Cookie im Browser: 30 Minuten nach der letzten
 * Erneuerung löscht der Browser es, egal wie fleissig man es benutzt hat. Wer
 * danach mit einem nackten `fetch(…, { credentials: 'include' })` ein
 * Cookie-Endpoint fragt (der 2-Minuten-Takt der App-Host-Anwesenheit, der
 * Telefonbuch-Nachschlag des Direktpfads), bekommt 401 „missing session
 * cookie", und der Browser schreibt die fehlgeschlagene Anfrage rot in die
 * Konsole — auch wenn die App das 401 als „unbekannt" wegsteckt
 * (`direct/policy.ts::deuteTelefonbuch`).
 *
 * Zweiter Auslöser, derselbe Mechanismus: der App-Start. `auth.hydrate()`
 * erneuert das Cookie im Hintergrund (nicht abgewartet), der Takt der
 * Anwesenheit feuert zugleich — nach einer Pause über 30 Minuten ohne Cookie.
 * Beide Lagen sind im Browser nachgestellt (ohne die Absicherung 401, mit ihr
 * 404 der Cloud; `tests/e2e/telefonbuch-sitzung.spec.ts`). Aus dem Code
 * gefolgert, nicht gemessen: selbst MIT Cookie kann die Erneuerung das alte
 * gerade widerrufen (`/session/renew` entwertet die abgelöste Sitzung),
 * während eine Anfrage damit noch unterwegs ist.
 *
 * Ein 401 nachträglich zu wiederholen macht die rote Zeile nicht ungeschehen —
 * deshalb wird VOR der Anfrage entschieden, ob erst erneuert werden muss. Das
 * Cookie ist `HttpOnly`, JS kann es nicht ansehen; was bleibt, ist der
 * Zeitpunkt der letzten Erneuerung, den der Klient selbst kennt.
 */

/** `Max-Age` des Cookies (`browser_sessions._DEFAULT_TTL`, 30 Minuten). */
export const COOKIE_LEBENSDAUER_MS = 30 * 60_000;

/** Wie früh vor dem Ablauf neu erneuert wird: deckt Uhrabweichung zwischen
 *  Rechner und Server sowie die Laufzeit der Anfrage selbst. */
export const RESERVE_MS = 3 * 60_000;

/**
 * Muss erst erneuert (bzw. eine laufende Erneuerung abgewartet) werden, bevor
 * eine Cookie-Anfrage rausgeht?
 *
 * - Läuft gerade eine Erneuerung: ja, abwarten — sie tauscht das Cookie aus
 *   und entwertet das alte, eine Anfrage dazwischen kann mit dem toten
 *   Cookie ankommen.
 * - Noch nie erneuert (frische Seite, Anmeldung ohne Neuladen): ja, einmal.
 *   Das ist billig (204) und gilt danach für die nächsten 27 Minuten.
 * - Letzte Erneuerung länger als `LEBENSDAUER − RESERVE` her: ja.
 * - Uhr zurückgestellt (Alter negativ): ja — dem Zeitstempel ist dann nicht
 *   zu trauen.
 */
export function sitzungMussErneuertWerden(
  belegtAm: number | null,
  jetzt: number,
  erneuerungLaeuft: boolean
): boolean {
  if (erneuerungLaeuft) return true;
  if (belegtAm === null) return true;
  const alter = jetzt - belegtAm;
  return alter < 0 || alter >= COOKIE_LEBENSDAUER_MS - RESERVE_MS;
}

/** Was `mitCloudSitzung` von der Umgebung braucht (in Tests ersetzbar). */
export interface SitzungsHaken<R extends { status: number }> {
  jetzt(): number;
  /** Zeitpunkt der letzten erfolgreichen Erneuerung, `null` = keine bekannt. */
  belegtAm(): number | null;
  erneuerungLaeuft(): boolean;
  /** Cookie neu prägen; `false` = es ging nicht (kein Bearer, Netz, 401). */
  erneuere(): Promise<boolean>;
  anfrage(): Promise<R>;
}

/**
 * Die Cookie-Anfrage erst stellen, wenn eine Cloud-Sitzung besteht.
 *
 * - Gibt es keine belastbare Sitzung und die Erneuerung scheitert, geht die
 *   Anfrage GAR NICHT raus (`null`): sie käme ohnehin als 401 zurück und
 *   stünde nur rot in der Konsole.
 * - Kommt trotz belegter Sitzung ein 401 (Sitzung serverseitig beendet),
 *   wird einmal erneuert und einmal wiederholt — nie öfter.
 */
export async function mitCloudSitzung<R extends { status: number }>(
  haken: SitzungsHaken<R>
): Promise<R | null> {
  if (sitzungMussErneuertWerden(haken.belegtAm(), haken.jetzt(), haken.erneuerungLaeuft())) {
    if (!(await haken.erneuere())) return null;
  }
  const erste = await haken.anfrage();
  if (erste.status !== 401) return erste;
  if (!(await haken.erneuere())) return erste;
  return haken.anfrage();
}
