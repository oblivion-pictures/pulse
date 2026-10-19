/**
 * Zeigt dieser Client den Standplatz-Reiter?
 *
 * **Nicht dieselbe Frage wie `darfStandplatzSein()`** — die beantwortet „kann
 * dieser RECHNER Standplatz sein" und hängt an der Anmeldung
 * (`ws/handlers/ready.ts`) und der Übernahme (`remote/session.svelte.ts`). Die
 * beiden liefen am 2026-08-18 schon einmal auseinander: der Reiter war unter
 * Linux versteckt, die vorhandene Eintragung meldete sich trotzdem weiter an.
 * Deshalb steht die Reiter-Regel hier und fasst jene nicht an.
 *
 * Importfrei für Nodes Testläufer.
 */
export function reiterSichtbar(s: {
  kannStandplatzSein: boolean;
  /** Kann diese Plattform überhaupt Host sein ({@link hostPlattform})? */
  hostPlattform: boolean;
  hatEintragung: boolean;
  besitztGeraete: boolean;
}): boolean {
  return s.kannStandplatzSein || s.hostPlattform || s.hatEintragung || s.besitztGeraete;
}

/**
 * Kann diese Plattform Host einer Fernsteuerung sein — unabhängig davon, ob
 * die Fähigkeit schon gemessen oder (auf dem Mac) freigegeben ist?
 *
 * **Warum hier ausnahmsweise die Plattform zählt und nicht die Fähigkeit**
 * (`darfStandplatzSein.ts` erklärt, warum sonst die Fähigkeit gilt): gemessen
 * wird die Fähigkeit nur, wenn ein Anlass den Sidecar ohnehin braucht
 * (`pruefeGesundheit()` in `stream/state.svelte.ts`) — der Boot-Probe ist seit
 * dem 2026-10-06 weg, weil er für jeden einen Prozess startete. Hing der
 * Einstieg an der Messung, sah ein frisch installierter Rechner ohne
 * Eintragung und ohne eigene Geräte den Knopf nie (Befund 2026-10-19, Mac UND
 * Windows). Auf dem Mac ist der Einstieg außerdem genau der Ort, an dem man
 * die fehlenden Systemfreigaben erklärt bekommt und anfordert — ihn erst nach
 * erteilter Freigabe zu zeigen, wäre ein Kreis ohne Eingang.
 *
 * Der Einstieg verspricht dabei nichts: das Panel misst beim Öffnen und bietet
 * eine Eintragung nur an, wenn `darfStandplatzSein()` steht.
 *
 * `os` ist `window.pulse.os` (`process.platform` aus dem Preload),
 * `sidecarBruecke` = `sidecar.available()` — die Brücke, nicht das Binary.
 */
export function hostPlattform(s: {
  electron: boolean;
  os: string | undefined;
  sidecarBruecke: boolean;
}): boolean {
  return s.electron && s.sidecarBruecke && (s.os === 'darwin' || s.os === 'win32');
}
