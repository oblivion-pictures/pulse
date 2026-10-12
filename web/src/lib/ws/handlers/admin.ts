/**
 * Hosting-Anträge in Echtzeit — nur noch die Admin-Seite.
 *
 * `admin_application_pending` (admin:events → nur Admin-Sockets): ein neuer
 * Antrag liegt vor. Das Gegenstück `application_decided` an den Antragsteller
 * ist mit „Meine Server“ entfallen (2026-10): es gibt keinen eigenen Antrag
 * mehr zu beobachten.
 *
 * Das Ereignis trägt nur das Signal, keine Antragsdaten — der Store lädt seine
 * Liste danach über den regulären REST-Endpoint nach.
 */
import { pendingAppHostApplications } from '$lib/stores/pendingAppHostApplications.svelte';
import { pendingInstanceApps } from '$lib/stores/pendingInstanceApps.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('admin_application_pending', (evt) => {
    if (evt.kind === 'app_host') pendingAppHostApplications.refresh();
    else pendingInstanceApps.refresh();
  });
}
