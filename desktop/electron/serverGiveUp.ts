/**
 * "Server aufgeben" — Schritt-Sequenz als reine, testbare Funktion mit
 * injizierten Ops (Muster serverSupersede/autostart). main.ts liefert die
 * echten Ops (Container/Cloud/Autostart/Store), hier lebt nur die
 * Reihenfolge- und Teil-Fehler-Semantik:
 *
 *   Cloud-Registrierung löschen (optional übersprungen, z.B. im
 *   superseded-Zustand: die Creds sind dort ohnehin entwertet) → Container
 *   stoppen+entfernen → Autostart-Eintrag weg → Pairing löschen → bei
 *   deleteData das Daten-Volume entfernen (NACH dem Container-rm, sonst
 *   "in use").
 *
 * Die Cloud kommt ZUERST, weil sie seit dem Sicherheitsfund 2026-11-04 das
 * Kontopasswort verlangt: ist es falsch, bricht die Aufgabe ab, bevor das
 * Gerät angefasst wurde — der Nutzer kann es mit dem richtigen Passwort
 * erneut versuchen. Bis dahin lief der Container-Abbau vorneweg.
 *
 * Sonst läuft jeder Schritt best-effort weiter — ein aufgegebener Server soll das
 * Gerät auch dann verlassen, wenn z.B. die Cloud gerade nicht erreichbar ist.
 * Das Ergebnis meldet pro heiklem Schritt den Ausgang, damit die UI ehrlich
 * sagen kann, was liegen blieb. Keine Electron-Imports.
 */

export type CloudDeleteVerdict = 'ok' | 'unauthorized' | 'wrong_password' | 'error';

/** Reine Entscheidung aus dem HTTP-Status des DELETE /me/instances/{id}:
 *  404 = schon gelöscht → Erfolg; 401 mit `invalid credentials` = Passwort
 *  falsch (Prüfung wie pairing.classifyMintStatus); sonstiges 401/403 =
 *  Session fehlt/abgelaufen → Nutzer-Hinweis auf den Client-Weg; Rest (5xx,
 *  Transportfehler=0) = Fehler. */
export function classifyDeleteStatus(status: number, json?: unknown): CloudDeleteVerdict {
  if (status === 404 || (status >= 200 && status < 300)) return 'ok';
  if (status === 401 && (json as { detail?: unknown } | null)?.detail === 'invalid credentials') {
    return 'wrong_password';
  }
  if (status === 401 || status === 403) return 'unauthorized';
  return 'error';
}

export interface GiveUpOps {
  /** Container stoppen + rm -f (fehlender Container ist kein Fehler). */
  removeContainer(): Promise<void>;
  /** DELETE /me/instances/{id} mit Session-Cookie und Kontopasswort. */
  deleteCloudRegistration(): Promise<CloudDeleteVerdict>;
  /** Autostart-Eintrag entfernen (Login-Items / XDG-Datei). */
  removeAutostart(): void;
  /** Creds löschen + Lifecycle auf idle. */
  clearPairing(): void;
  /** `volume rm pulse-host-data` — true bei Erfolg. */
  removeDataVolume(): Promise<boolean>;
}

export interface GiveUpResult {
  /** false nur bei falschem Passwort — dann wurde nichts angefasst. */
  ok: boolean;
  /** Cloud lehnte das Kontopasswort ab; die UI fragt erneut. */
  wrongPassword?: true;
  /** null = Cloud-Löschung bewusst übersprungen (superseded-Pfad). */
  cloudDeleted: boolean | null;
  /** null = Datenlöschung nicht angefordert. */
  dataDeleted: boolean | null;
  /** Diagnose der liegengebliebenen Schritte (nie Secrets). */
  errors: string[];
}

export async function runGiveUp(
  opts: { deleteData: boolean; skipCloud: boolean },
  ops: GiveUpOps,
): Promise<GiveUpResult> {
  const errors: string[] = [];

  let cloudDeleted: boolean | null = null;
  if (!opts.skipCloud) {
    const verdict = await ops.deleteCloudRegistration().catch(() => 'error' as const);
    if (verdict === 'wrong_password') {
      return { ok: false, wrongPassword: true, cloudDeleted: false, dataDeleted: null, errors: [] };
    }
    cloudDeleted = verdict === 'ok';
    if (!cloudDeleted) errors.push(`cloud: ${verdict}`);
  }

  await ops.removeContainer().catch((e: Error) => {
    errors.push(`container: ${e.message}`);
  });

  try { ops.removeAutostart(); } catch (e) { errors.push(`autostart: ${(e as Error).message}`); }
  try { ops.clearPairing(); } catch (e) { errors.push(`pairing: ${(e as Error).message}`); }

  let dataDeleted: boolean | null = null;
  if (opts.deleteData) {
    dataDeleted = await ops.removeDataVolume().catch(() => false);
    if (!dataDeleted) errors.push('volume: rm failed');
  }

  return { ok: true, cloudDeleted, dataDeleted, errors };
}
