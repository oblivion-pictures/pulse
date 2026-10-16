/**
 * Versand der Ton-Diagnose aus der iOS-App (Regeln und Drossel in
 * `iosTonDiagnose.ts`). Getrennt, weil das hier Nebenwirkungen hat und Stores
 * braucht — die Regeln dort bleiben ohne Netz prüfbar.
 *
 * **Derselbe Endpunkt und derselbe Schalter wie am Desktop:**
 * `POST /api/auth/experimental-logs` (öffentlich, 30/h je IP, 28 Tage
 * Aufbewahrung, Deckel 250 Ereignisse / 512 KiB — `routes_experimental_logs.py`),
 * Opt-out über `uploadDiagnosticLogs !== false` (`stream/diagnose-senden.ts`).
 * In der iOS-App steht der Schalter in den Ton-Einstellungen
 * (`IosTonEinstellungen.svelte`), weil es den Reiter „Experimental" dort nicht
 * gibt. Ausserhalb der Hülle wird nie gesendet.
 *
 * `role: 'app'` wie beim Käfer-Knopf, `reason: 'ios_ton_ausfall'` und
 * `plattform: 'ios'` im Kopf — daran findet die Admin-Ansicht „Diagnose" die
 * Berichte.
 */

import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import { spracheDiagnose } from '$lib/platform/iosSpracheWache';
import { isCapacitorIOS } from '$lib/platform/runtime';
import { loadAll } from '$lib/stream/persistence';
import type { BerichtSender } from './iosTonDiagnose';

async function darfSenden(): Promise<boolean> {
  if (!isCapacitorIOS()) return false;
  try {
    return (await loadAll()).uploadDiagnosticLogs !== false;
  } catch {
    return false;
  }
}

/** Bewusst Cloud-absolut, wie der Käfer-Knopf: ein aktiver Self-Host würde den
 *  Bericht sonst in SEINE Datenbank legen, wo ihn niemand sieht. */
function ziel(): string {
  return window.location.origin === CLOUD_HOSTNAME || import.meta.env.DEV
    ? '/api/auth/experimental-logs'
    : `${CLOUD_HOSTNAME}/api/auth/experimental-logs`;
}

export const iosTonBerichtSenden: BerichtSender = async ({ anlaesse, zeilen }) => {
  if (!(await darfSenden()) || zeilen.length === 0) return false;
  const jetzt = (await spracheDiagnose().catch(() => null)) ?? {};
  const kopf = {
    app: 'pulse-ios',
    plattform: 'ios',
    user_agent: navigator.userAgent,
    anlaesse,
    huelle_jetzt: jetzt,
    erstellt: new Date().toISOString()
  };
  const resp = await fetch(ziel(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      reason: 'ios_ton_ausfall',
      role: 'app',
      system_info: { plattform: 'ios', user_agent: navigator.userAgent },
      report: {
        kopf,
        bilanz: { zeilen: zeilen.length },
        ereignisse: zeilen,
        ereignisse_verworfen: 0,
        abschluss: { anlaesse }
      }
    })
  });
  return resp.ok;
};
