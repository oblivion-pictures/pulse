/**
 * Wie heißt ein Server in der Leiste, und steht er überhaupt drin? — reine
 * Rechnung, importfrei (prüfbar mit `pnpm test:unit`, Muster wie
 * `erstellrecht.ts`).
 *
 * **Name (2026-10-08).** Ein Heim-Server stand für jeden, der ihn nie geöffnet
 * hatte, als `rapid-comet-58ed.relay…` in der Leiste: den Namen kannte nur der
 * Server selbst, und der ready-Rahmen, der ihn liefert, kommt erst nach einer
 * Verbindung. Jetzt meldet der Server seinen Namen an die Cloud, und die
 * liefert ihn mit `/me/instances` und live per `instance_status`. Vorrang:
 * dieser Cloud-Name (`anzeigename`, immer der neueste), dann der Name aus dem
 * letzten ready-Rahmen (`server_name`), dann die Adresse.
 *
 * **Sichtbarkeit (Entscheid 2026-10-08).** Ein gestoppter Heim-Server
 * verschwindet aus der Leiste — für alle, auch für den Betreiber. Nur
 * `origin === 'app_host'` mit ausdrücklichem `online === false`: VPS-Server
 * melden sich nicht beim Telefonbuch, und ein unbekannter Zustand
 * (`undefined`/`null`, ältere Cloud) darf NICHT ausblenden — sonst wäre die
 * Leiste auf einen Schlag leer, obwohl alle Server laufen.
 */

export interface AnzeigeEintrag {
  isCloud: boolean;
  label: string;
  hostname: string;
  server_name: string | null;
  anzeigename?: string | null;
  origin?: 'vps' | 'app_host' | null;
  online?: boolean | null;
}

export function anzeigeName(e: AnzeigeEintrag): string {
  if (e.isCloud) return e.label;
  return e.anzeigename || e.server_name || e.hostname;
}

/**
 * Der Server selbst nennt seinen Namen — im `ready`-Rahmen, im Live-Ereignis
 * einer Umbenennung oder als Antwort auf das eigene Speichern.
 *
 * **Beide Felder zugleich.** `anzeigename` (Cloud) gewinnt in `anzeigeName`
 * gegen `server_name`. Hätte man nur `server_name` gesetzt, bliebe nach einer
 * Umbenennung der alte Cloud-Name stehen, solange die Meldung des Servers an
 * die Cloud noch unterwegs ist — oder dauerhaft, wenn sie scheitert (Cloud
 * kurz weg): der Betreiber sähe seinen neuen Namen nirgends. Der Server ist
 * die Quelle dieses Namens; was er gerade sagt, ist frischer als die Kopie in
 * der Cloud. Kommt die Cloud-Meldung danach an, trägt sie denselben Wert.
 */
export function nameVomServer(name: string | null | undefined): {
  server_name: string | null;
  anzeigename: string | null;
} {
  const n = name?.trim() || null;
  return { server_name: n, anzeigename: n };
}

export function istSichtbar(e: AnzeigeEintrag): boolean {
  if (e.isCloud) return true;
  return !(e.origin === 'app_host' && e.online === false);
}
