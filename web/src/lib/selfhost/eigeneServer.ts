/**
 * Hat dieses Konto einen eigenen Server? — reine Rechnung, importfrei
 * (Node-Unit-Test, s. `pnpm test:unit`-Falle in CLAUDE.md).
 *
 * Entscheidet, ob „Meine Server“ im Konto-Menü (`UserFooter`) und im
 * Du-Bereich (`MeSectionList`) erscheint (Spec 2026-10-09 §5). Eine Stelle für
 * beide, damit sie nicht auseinanderlaufen.
 *
 * **Quelle ist die Server-Liste des Kontos, nie der aktive Server.** Die Rolle
 * kommt aus `GET /me/instances` (`hydrateFromBackend`), also aus der Cloud,
 * und gilt unabhängig davon, welcher Server gerade aktiv ist. Bis 2026-08-28
 * hing der damalige Einstieg am aktiven Server — und fehlte ausgerechnet dem,
 * der auf seinem eigenen Server nach der Verwaltung suchte.
 *
 * Instanzen, deren Zugangsdaten nie abgeholt wurden (`set_up === false`),
 * stehen nicht in der Liste und zählen deshalb nicht. Für neue Server gibt es
 * diesen Zustand nicht mehr: verbunden heißt abgeholt (Spec E3).
 */
export function hatEigeneServer(
  servers: ReadonlyArray<{ isCloud: boolean; role?: string | null }>
): boolean {
  return servers.some((s) => !s.isCloud && s.role === 'owner');
}
