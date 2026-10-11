/**
 * Wann der PushKit-Token (erneut) beim Server angemeldet wird — die reine
 * Entscheidung, ohne Import (Nodes Testläufer, CLAUDE.md). Verdrahtet in
 * `voipToken.ts`.
 *
 * **Eine Meldung ist Token, Kette und Fähigkeiten zusammen.** Bis zur
 * Nachprüfung der Fix-Runden meldete die Seite nur den Token, und den einmal
 * je Dokument:
 *
 *  - **S3 — die Kette.** Der Server hängt die Zeile an die Anmelde-Kette des
 *    Aufrufers (`_geraetetoken.py`, iOS-Bughunt 2, C2) und löscht sie, wenn
 *    die Kette endet. Ein Passwortwechsel am Telefon gibt diesem Gerät eine
 *    NEUE Kette und lässt die alte stehen, ohne ihr Ende zu melden
 *    (`routes_account_security.py`). Die Zeile blieb an der alten — und ein
 *    späterer Widerruf der neuen (Telefon verloren) liess das Telefon weiter
 *    mit dem Namen des Anrufers klingeln.
 *  - **S2 — die Fähigkeiten.** Nur eine Hülle mit
 *    `MitteilungImVordergrund.swift` unterdrückt DM-Banner, solange die App
 *    vorn ist; nur an sie darf der Server DMs ohne Frische-Prüfung pushen
 *    (`fcm_empfaenger.py`). Sie sagt es mit der Anmeldung.
 *
 * Ändert sich eins davon, wird neu gemeldet; sonst nicht (das Band des
 * Gateways, `voip_token`: 10 je Minute).
 */

export interface VoipMeldung {
  token: string;
  /** Die Anmelde-Kette aus dem Zugriffs-Token (Claim `kette`) — `null`,
   *  wenn das Token keine trägt. */
  kette: string | null;
  /** Was die Hülle von sich sagt. `null`: eine ältere Hülle sagt nichts —
   *  „unbekannt", und der Server bleibt beim vorsichtigen Riegel. */
  faehigkeiten: string[] | null;
}

/** Muss `neu` gemeldet werden, wenn zuletzt `gemeldet` angekommen ist? */
export function meldungNoetig(gemeldet: VoipMeldung | null, neu: VoipMeldung): boolean {
  if (!neu.token) return false;
  if (!gemeldet) return true;
  return (
    gemeldet.token !== neu.token ||
    gemeldet.kette !== neu.kette ||
    alsText(gemeldet.faehigkeiten) !== alsText(neu.faehigkeiten)
  );
}

/** „Unbekannt" (`null`) und „nichts" (`[]`) bleiben verschieden. */
function alsText(faehigkeiten: string[] | null): string {
  return faehigkeiten === null ? '?' : `[${faehigkeiten.join(',')}]`;
}

/** Die Fähigkeiten aus der Antwort der Hülle. Alles, was keine Liste von
 *  Wörtern ist, heisst „unbekannt" (`null`). */
export function faehigkeitenAusHuelle(roh: unknown): string[] | null {
  if (!Array.isArray(roh) || !roh.every((f) => typeof f === 'string')) return null;
  return [...roh].sort();
}

/** Die Kette aus dem entpackten Zugriffs-Token (`api/storage.ts::jwtPayload`). */
export function ketteAusZugriff(nutzlast: Record<string, unknown> | null): string | null {
  const kette = nutzlast?.kette;
  return typeof kette === 'string' && kette ? kette : null;
}
