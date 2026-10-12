/**
 * Der Name, unter dem ein Self-Host in der eigenen Serverliste steht — für die
 * Einladungskarte, die sonst nur die Adresse zeigt.
 *
 * **Nur für Server, die das Gerät schon kennt.** Bei einem unbekannten Host ist
 * die Adresse der Teil der Karte, an dem man erkennt, wohin man sich verbindet
 * (Erstkontakt-Zustimmung, Spec 2026-10-10 Sicherheit 2) — und einen Namen
 * kennen wir dort ohnehin nicht, ohne den Host vorher anzufragen. Für einen
 * Server, in dem man schon ist, trägt die Liste den Namen des Betreibers
 * (`anzeigename` aus der Cloud, `server_name` aus der letzten Verbindung).
 */
import { serversStore } from '$lib/api/servers.svelte';

export function bekannterServerName(host: string | null | undefined): string | null {
  if (!host) return null;
  const s = serversStore.findByHostname(host);
  if (!s || s.isCloud) return null;
  return s.anzeigename || s.server_name || null;
}
