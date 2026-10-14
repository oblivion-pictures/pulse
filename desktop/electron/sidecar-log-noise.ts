/**
 * Rausch-Politik für die `sidecar.log` — welche Protokollzeilen NICHT
 * mitgeschrieben werden.
 *
 * Warum das nötig ist: der Sidecar meldet einmal pro Sekunde und Stream
 * `{"ev":"fps",…}`. Ungefiltert waren das in einem echten Log ~94 % aller
 * Zeilen (~340 KB pro Stream-Stunde). Der Diagnose-Upload überträgt nur den
 * letzten 512-KiB-Ausschnitt der Datei — bei einem langen Stream besteht der
 * dann ausschließlich aus fps-Zeilen, und genau die Zeilen, die einen Fehler
 * erklären (Sidecar-Start mit Version, Import-Versuch pro Render-Node,
 * gewählter Encode-Pfad, FFmpegs av_log-Ausgabe), sind herausgedrängt.
 *
 * **Die Fernsteuerung hat dasselbe Muster, nur lauter** (2026-10-14): jede
 * Eingabe-Anfrage bekommt eine Quittung (`{"id":…,"ok":true,"processed":…,
 * "state":…}`, `ops/remote_input.rs`), bis zu 125 je Sekunde (`player.ts`),
 * dazu eine Zeigerform-Meldung bei jedem Wechsel (`"ev":"remote_pointer"`).
 * Im Log einer Fernsteuer-Sitzung waren das 12 443 Quittungen und 1 600
 * Zeigerformen. Sie leerten den Vorrat der Drossel (`sidecar-log-drossel.ts`),
 * und die liess 187-mal Zeilen fallen — darunter die, die man brauchte: der
 * Ton-Untersuchung fehlten Zeilen aus genau den Minuten der Aussetzer.
 *
 * Ganz wegwerfen wäre zu grob: ob überhaupt Frames entstanden, ob überhaupt
 * Eingaben ankamen, ist die halbe Diagnose. Deshalb je Sorte eine Stichprobe
 * pro Minute. **Eine abgelehnte Eingabe** (`"ok":false`) ist keine Quittung im
 * Sinne dieser Regel und geht immer durch. Und die Quittungen zählen **je
 * Zustand** getrennt: auch `ended`, `masked`, `unknown_slot` kommen mit
 * `"ok":true` (`pulse-fernsteuerung/src/sitzung.rs`), und genau sie erklären,
 * warum Eingaben nicht ankommen — ein Wechsel von `live` nach `masked` steht
 * deshalb sofort im Log, sofern `masked` nicht schon in der letzten Minute
 * eine Stichprobe bekam.
 *
 * Bewusst ohne `electron`-Import und ohne Uhr-Zugriff (`now` kommt herein):
 * so ist die Politik als reine Funktion testbar — `sidecar-log.ts` selbst ist
 * es nicht, weil es `app.getPath()` braucht.
 */

/** Abstand zwischen zwei mitgeschriebenen Stichproben derselben Sorte. */
export const FPS_SAMPLE_MS = 60_000;

export type NoiseFilter = (stream: string, text: string, now: number) => boolean;

/** Welche Sorte Rauschzeile das ist — oder `null`, wenn keine. */
function sorte(text: string): string | null {
  // Erkennung per Substring statt JSON.parse: das läuft bis zu 125×/s.
  if (text.includes('"ev":"fps"')) return 'fps';
  if (text.includes('"processed":') && text.includes('"ok":true')) {
    return `eingabe:${/"state":"([a-z_]+)"/.exec(text)?.[1] ?? '?'}`;
  }
  // Mit Komma: `"ev":"remote_pointer_in_frame"` (macOS) ist ein seltener,
  // aussagekräftiger Wechsel und gehört nicht in die Stichprobe.
  if (text.includes('"ev":"remote_pointer",')) return 'zeiger';
  return null;
}

/**
 * Baut den Filter. Rückgabe `true` = diese Zeile unterdrücken.
 *
 * Der Zustand (wann zuletzt eine Zeile je Sorte durchgelassen wurde) steckt im
 * Closure, damit mehrere Aufrufer sich nicht gegenseitig stören und ein Test
 * bei null anfängt.
 */
export function createNoiseFilter(sampleMs: number = FPS_SAMPLE_MS): NoiseFilter {
  // Fehlender Eintrag = seit dem letzten Abschnitt noch keine Stichprobe.
  // Bewusst nicht `0` als Ersatz: das hieße „bei Zeitstempel 0 geloggt" und
  // würde die erste Zeile nur deshalb durchlassen, weil `Date.now()` zufällig
  // eine große Zahl ist — mit einer bei 0 beginnenden Uhr (Test, monotone
  // Quelle) fiele sie weg.
  const zuletzt = new Map<string, number>();

  return (stream, text, now) => {
    // Nur der stdout-Protokollstrom rauscht; stderr/lifecycle sind rar und
    // tragen im Fehlerfall die Begründung — die nie unterdrücken.
    if (stream !== 'out') return false;

    // Ein State-Übergang beginnt einen neuen Stream-Abschnitt: die nächste
    // Zeile jeder Sorte wieder mitnehmen, damit auch ein Stream, der keine
    // volle Minute läuft, seinen Beleg über Frames und Eingaben hinterlässt.
    if (text.includes('"ev":"state"')) {
      zuletzt.clear();
      return false;
    }

    const art = sorte(text);
    if (!art) return false;

    const vorher = zuletzt.get(art);
    if (vorher !== undefined && now - vorher < sampleMs) return true;
    zuletzt.set(art, now);
    return false;
  };
}
