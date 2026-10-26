/**
 * Gelten auf diesem Server die Nutzungsbedingungen von howispulse.com?
 *
 * Die AGB und die Datenschutzerklärung im Ordner `legal/` gelten nur für den
 * Dienst unter howispulse.com (Hinweis am Ende beider Texte). Dieselbe
 * Oberfläche läuft aber auch auf Self-Hosts: Gast-Links öffnen auf dem Server,
 * dem der Kanal gehört, und ein Self-Host mit lokalen Konten zeigt die
 * Registrierung. Dort wäre ein Häkchen „Ich akzeptiere die Nutzungsbedingungen"
 * mit Link auf unsere AGB irreführend — der Betreiber hat eigene, und der
 * Server fragt die Zustimmung nicht ab (`services/auth/src/dcc_auth/agb.py`).
 *
 * Erkannt wird das am eigenen `/.well-known/pulse-server-info`: die Cloud
 * meldet `instance_id: null`, ein Self-Host seine Instanz-Nummer. Kommt keine
 * lesbare Antwort (Netzfehler, Entwicklungs-Server ohne diese Route), gilt der
 * Server als Cloud: lieber einen Hinweis zu viel zeigen als in der Cloud einen
 * zu wenig. Die Regel steht importfrei in [`istCloudInfo`], damit sie mit Nodes
 * Testläufer prüfbar bleibt.
 */

/** Ist das eine Antwort der Cloud? Alles, was keine Self-Host-Antwort ist, zählt als Cloud. */
export function istCloudInfo(info: unknown): boolean {
  if (typeof info !== 'object' || info === null) return true;
  const id = (info as { instance_id?: unknown }).instance_id;
  return id === null || id === undefined;
}

let antwort: Promise<boolean> | null = null;

/** Einmal je Seitenaufruf gefragt; spätere Aufrufe teilen die Antwort. */
export function istCloudServer(): Promise<boolean> {
  antwort ??= fetch('/.well-known/pulse-server-info', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then(istCloudInfo)
    .catch(() => true);
  return antwort;
}
