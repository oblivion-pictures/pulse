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
 *
 * **Und der Rücksprung.** Scheitert die Meldung des Servers an die Cloud
 * (Wiederholung nur alle 6 Stunden), liefert jeder Abgleich mit der Cloud
 * (`instanzNachzug`) und jedes Statusereignis weiter den ALTEN Namen und
 * überschriebe den neuen wieder. Deshalb merkt sich der Eintrag die Cloud-
 * Kopie, die der Name des Servers gerade überholt hat (`name_ueberholt`), und
 * `cloudNameAnwenden` ignoriert genau diesen Wert. Ohne Uhr: „neuer“ heißt hier
 * „ein anderer Wert als der überholte“ — die Cloud holt auf (dann trägt sie
 * den Namen des Servers oder einen noch neueren), sobald sie etwas anderes
 * meldet, und der Marker fällt weg.
 */
export function nameVomServer(
  name: string | null | undefined,
  alt: { anzeigename?: string | null; name_ueberholt?: string | null } = {},
): {
  server_name: string | null;
  anzeigename: string | null;
  name_ueberholt: string | null;
} {
  const n = name?.trim() || null;
  const vorher = alt.anzeigename ?? null;
  // Nennt der Server denselben Namen noch einmal (jeder ready-Rahmen, jedes
  // Neuverbinden), bleibt die Marke stehen: sonst brächte der nächste
  // Cloud-Abgleich die überholte Kopie zurück, solange die Meldung des Servers
  // an die Cloud nicht durch ist.
  const behalten = vorher === n && alt.name_ueberholt !== n ? (alt.name_ueberholt ?? null) : null;
  return {
    server_name: n,
    anzeigename: n,
    name_ueberholt: vorher !== null && vorher !== n ? vorher : behalten,
  };
}

/**
 * Die Cloud nennt den Namen des Servers (`/me/instances`, `instance_status`).
 * Gilt sie als Stand, oder ist es genau die Kopie, die der Server schon
 * überholt hat? (`nameVomServer`.) Gibt die neuen Werte für `anzeigename` und
 * `name_ueberholt` zurück.
 *
 * **Bekannte Grenze.** Wird der Server von A auf B und danach zurück auf A
 * umbenannt, während dieses Gerät nicht mit ihm verbunden ist, bleibt B stehen,
 * bis der nächste `ready`-Rahmen (jede Verbindung) A nennt: die Cloud meldet
 * dann A — genau den überholten Wert.
 */
export function cloudNameAnwenden(
  e: { anzeigename?: string | null; name_ueberholt?: string | null },
  cloud: string | null | undefined,
): { anzeigename: string | null; name_ueberholt: string | null } {
  const neu = cloud ?? null;
  const ueberholt = e.name_ueberholt ?? null;
  if (ueberholt !== null && neu === ueberholt) {
    return { anzeigename: e.anzeigename ?? null, name_ueberholt: ueberholt };
  }
  return { anzeigename: neu, name_ueberholt: null };
}

export function istSichtbar(e: AnzeigeEintrag): boolean {
  if (e.isCloud) return true;
  return !(e.origin === 'app_host' && e.online === false);
}
