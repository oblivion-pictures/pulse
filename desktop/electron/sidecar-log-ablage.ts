/**
 * Die geteilte Zwischenablage der Fernsteuerung in der `sidecar.log` — **nur
 * der Ablauf, nie der Inhalt**.
 *
 * **Der Anlass** (2026-10-15): Player und Sidecar melden jeden Ablage-Rahmen
 * als Ereignis auf stdout (`{"ev":"ablage","data":{…}}`), und `sidecar-log.ts`
 * schreibt stdout mit. Ein `stueck` trägt den kopierten Text (base64 in `d`) —
 * er stand damit im Klartext in der Datei, und deren letzte 512 KiB gehen beim
 * Diagnose-Upload an den Server: beim Sender automatisch am Stream-Ende. Wer
 * während einer Fernsteuerung ein Passwort einfügt, hätte es dorthin
 * geschickt. Genau das verhindert der Entwurf der Zwischenablage an jeder
 * anderen Stelle (verzögertes Rendern, `streaming/pulse-ablage`).
 *
 * **Positivliste statt Muster**, aus demselben Grund wie in
 * `sidecar-log-befehle.ts`: ein Muster auf `"d"` liesse ein künftiges
 * Inhaltsfeld mit anderem Namen durch. Hier bleibt nur stehen, was den Ablauf
 * beschreibt — Art, Generation, Abrufnummer, Stückzählung, Grund —, alles
 * andere wird unkenntlich. Die Feldnamen stammen aus
 * `streaming/pulse-ablage/src/format.rs` (`Rahmen::nach_json`).
 *
 * Bauart wie die Nachbarn: ohne `electron`-Import, reine Funktion, prüfbar.
 */

/** Felder eines Ablage-Rahmens, die keinen Inhalt tragen. */
const ABLAUF_FELDER: ReadonlySet<string> = new Set(['t', 'gen', 'id', 'i', 'n', 'typ', 'grund']);

/** Die Zeile mit unkenntlichem Ablage-Inhalt — andere Zeilen unverändert.
 *
 *  **Ein Vorsatz vor dem JSON bleibt stehen**: `player.ts` schreibt jede Zeile
 *  als `[pulse-player] {…}`, damit sie in der gemeinsamen Datei vom Sidecar zu
 *  unterscheiden ist. Geprüft wird ab der ersten geschweiften Klammer. */
export function ohneAblageInhalt(text: string): string {
  // Billige Vorprüfung: diese Funktion läuft für jede Zeile, auch für die
  // bis zu 125 Eingabe-Quittungen je Sekunde.
  if (!text.includes('"ablage"')) return text;
  const beginn = text.indexOf('{');
  const vorsatz = beginn > 0 ? text.slice(0, beginn) : '';
  let ereignis: unknown;
  try {
    ereignis = JSON.parse(beginn >= 0 ? text.slice(beginn) : text);
  } catch {
    // Nicht zerlegbar heisst nicht harmlos: im Zweifel nichts davon schreiben.
    return `${vorsatz}{"ev":"ablage","data":"***"}`;
  }
  if (!istObjekt(ereignis) || ereignis.ev !== 'ablage') return text;
  const data = ereignis.data;
  if (!istObjekt(data)) return vorsatz + JSON.stringify({ ...ereignis, data: '***' });
  const geschwaerzt: Record<string, unknown> = {};
  for (const [feld, wert] of Object.entries(data)) {
    geschwaerzt[feld] = ABLAUF_FELDER.has(feld) ? wert : '***';
  }
  return vorsatz + JSON.stringify({ ...ereignis, data: geschwaerzt });
}

function istObjekt(wert: unknown): wert is Record<string, unknown> {
  return wert !== null && typeof wert === 'object' && !Array.isArray(wert);
}
