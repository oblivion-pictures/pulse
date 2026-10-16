/**
 * Kennt der Server das Gerätestrom-Merkmal (`device_id` an der
 * Stream-Token-Anfrage) nicht? — als reine Regel.
 *
 * Seit 2026-10-16 schickt ein Remote-Rechner beim Stream-Start seine
 * Geräte-ID mit (`starten.ts`). Ältere Server — Self-Hosts und die
 * Windows-Server-App ohne Update — prüfen den Anfragekörper mit
 * `extra="forbid"` und antworten auf das unbekannte Feld mit 422. Ohne
 * Rückfall überträgt ein Gerät an einem solchen Server nie.
 *
 * **Nur genau diese Antwort löst den Rückfall aus**: 422 mit einem Eintrag
 * `extra_forbidden` an `device_id`. Ein Server, der das Feld kennt, liefert
 * diese Form nie (bei ihm ist `device_id` ein gültiges Feld) — ein anderer
 * 422 (etwa eine kaputte ID) bleibt ein Fehler, statt still zu einem
 * normalen Strom ohne Zuschau-Schranke zu werden. Beim alten Server geht
 * nichts verloren: er kennt die Schranke ohnehin nicht.
 *
 * Importfrei, damit Nodes Testläufer es prüfen kann (`pnpm test:unit`-Falle).
 */

/** FastAPI-Fehlerkörper bei 422: `{"detail": [{"type", "loc", ...}]}`. */
export function serverKenntGeraetMerkmalNicht(status: number, body: unknown): boolean {
  if (status !== 422 || typeof body !== 'object' || body === null) return false;
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) return false;
  return detail.some((e) => {
    if (typeof e !== 'object' || e === null) return false;
    const { type, loc } = e as { type?: unknown; loc?: unknown };
    return (
      type === 'extra_forbidden' &&
      Array.isArray(loc) &&
      loc[loc.length - 1] === 'device_id'
    );
  });
}
