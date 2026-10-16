/**
 * Der Umfang einer Server-Freigabeliste, wie ihn `RemoteStandplatzBanner`
 * anzeigt: „jeder" (ein gültiger `everyone`-Eintrag) oder die Anzahl der
 * übrigen gültigen Einträge (Nutzer und Rollen zusammen — das Banner sagt
 * nicht, WER freigegeben ist, nur WIE VIELE), dazu wann die letzte Freigabe
 * endet.
 *
 * **Abgelaufene Zeilen zählen nicht** (seit 2026-10-16): der Server fegt sie
 * nicht weg, sie bleiben in der Liste stehen — wirken aber nicht mehr. Vorher
 * zählte das Banner sie mit, und es nannte als Ablauf den des lokalen
 * Schalters, der seit 2026-09-09 immer dauerhaft gesetzt wird: „ohne Ablauf",
 * während die einzige Freigabe in einer Stunde endete.
 *
 * Importfrei, damit Nodes eingebauter Testläufer sie direkt laden kann
 * (Muster wie `restzeit.ts`).
 */
interface FreigabenUmfang {
  jeder: boolean;
  /** Gültige Einträge ohne `everyone`. */
  anzahl: number;
  /**
   * Wann die letzte gültige Freigabe endet (ms seit Epoche), `'dauerhaft'`,
   * wenn eine ohne Ablauf darunter ist, `null`, wenn keine gilt.
   */
  ende: number | 'dauerhaft' | null;
}

export function freigabenUmfang(
  grants: { subject_type: 'user' | 'role' | 'everyone'; expires_at: string | null }[],
  jetzt: number,
): FreigabenUmfang {
  let jeder = false;
  let anzahl = 0;
  let ende: number | 'dauerhaft' | null = null;
  for (const g of grants) {
    const bis = g.expires_at === null ? null : Date.parse(g.expires_at);
    // Unlesbarer Zeitpunkt = abgelaufen, wie in `restzeit.ts`.
    if (bis !== null && !(bis > jetzt)) continue;
    if (g.subject_type === 'everyone') jeder = true;
    else anzahl += 1;
    if (bis === null) ende = 'dauerhaft';
    else if (ende !== 'dauerhaft') ende = Math.max(ende ?? 0, bis);
  }
  return { jeder, anzahl, ende };
}
