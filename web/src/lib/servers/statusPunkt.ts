/**
 * Farbe des Status-Punkts am Server-Kopf der Leiste (`GuildRail`) — aus
 * `GuildRail.svelte` herausgelöst (Größen-Policy), unverändert. Reine Rechnung,
 * importfrei.
 *
 * Wird nur im Ausnahmezustand gerendert (`open` zeigt keinen Punkt), daher gibt
 * es keinen grünen Fall.
 */
export function serverStateDotColor(state: string): string {
  if (state === 'connecting' || state === 'starting' || state === 'updating') return 'bg-warning';
  // Sperre und E-Mail-Riegel sind Ausnahmezustaende mit Handlungsbedarf —
  // rot, nicht das gelbe „kommt gleich wieder".
  if (
    state === 'incompatible' ||
    state === 'email-unverified' ||
    state === 'suspended' ||
    state === 'mfa-required'
  )
    return 'bg-destructive';
  return 'bg-gray-500';
}
