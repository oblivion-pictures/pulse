/**
 * `HTMLMediaElement.play()` und sein Abbruch — ohne Import (Pflicht für
 * `pnpm test:unit`, s. CLAUDE.md).
 *
 * `play()` liefert ein Promise, und das wird mit `AbortError` abgelehnt, wenn
 * das Element in der Zwischenzeit pausiert, neu geladen oder aus dem Dokument
 * genommen wird („The play() request was interrupted by a call to pause()").
 * Das ist kein Fehler, sondern der Normalfall eines Abspielversuchs, den
 * jemand anderes überholt hat: das Element steht dann dort, wo der Überholer
 * es hinhaben wollte. Wer das Promise nicht abfängt, bekommt trotzdem
 * „Uncaught (in promise) AbortError" in die Konsole.
 *
 * Abgefangen wird NUR dieser eine Fall. `NotAllowedError` (Autoplay gesperrt)
 * und alles andere gehen weiter nach oben — dort entscheidet der Aufrufer,
 * ob ein „Ton ist gesperrt"-Hinweis fällig ist.
 */

/** Wie oft `Room.startAudio()` nach einem Abbruch höchstens noch einmal
 *  versucht wird (also bis zu 3 Versuche insgesamt), bevor der Abbruch still
 *  hingenommen wird. */
const STARTAUDIO_WIEDERHOLUNGEN = 2;

/** Was nach einem fehlgeschlagenen Abspielversuch geschieht. */
export type FolgeNachFehler =
  /** Überholt, und es sind noch Versuche übrig: noch einmal. */
  | 'wiederholen'
  /** Überholt, keine Versuche mehr: still enden, kein Fehler. */
  | 'verwerfen'
  /** Kein Abbruch (z. B. Autoplay-Sperre): dem Aufrufer zeigen. */
  | 'weiterreichen';

/** Ist das der Abbruch eines Abspielversuchs (`play()` wurde überholt)? */
export function istAbspielAbbruch(fehler: unknown): boolean {
  return (
    typeof fehler === 'object' &&
    fehler !== null &&
    (fehler as { name?: unknown }).name === 'AbortError'
  );
}

/** Entscheidung nach einem Fehler: `wiederholungen` = wie oft schon wiederholt
 *  wurde, `erlaubt` = wie oft insgesamt wiederholt werden darf. */
export function folgeNachFehler(
  fehler: unknown,
  wiederholungen: number,
  erlaubt: number
): FolgeNachFehler {
  if (!istAbspielAbbruch(fehler)) return 'weiterreichen';
  return wiederholungen < erlaubt ? 'wiederholen' : 'verwerfen';
}

/** Führt `aktion` aus; ein Abspiel-Abbruch endet still (nach höchstens
 *  `wiederholungen` weiteren Versuchen), jeder andere Fehler wird
 *  weitergereicht. */
async function ohneAbbruch(aktion: () => Promise<void>, wiederholungen = 0): Promise<void> {
  for (let bisher = 0; ; bisher++) {
    try {
      await aktion();
      return;
    } catch (fehler) {
      const folge = folgeNachFehler(fehler, bisher, wiederholungen);
      if (folge === 'weiterreichen') throw fehler;
      if (folge === 'verwerfen') return;
    }
  }
}

/** `el.play()`, ein überholter Versuch (`AbortError`) endet still; jeder andere
 *  Fehler wird weitergereicht. */
export function spieleAb(el: Pick<HTMLMediaElement, 'play'>): Promise<void> {
  return ohneAbbruch(() => el.play());
}

/**
 * LiveKit-Raum gegen den Abbruch seines EIGENEN `startAudio()` absichern.
 *
 * `Room` hängt `startAudio` beim Verbinden an das Ereignis
 * `AudioStreamAcquired` (das eigene Mikrofon steht) — also genau beim
 * Beitritt — und wirft die Antwort weg. `startAudio` spielt dabei jedes
 * Element ab, das an ein ferngehaltenes Audio-Track angehängt ist
 * (`track.attach()`: Ton einer Bildschirmfreigabe, Anruf- und Gast-Räume).
 * Pausiert LiveKit ein solches Element im selben Augenblick selbst
 * (`detach()` → `recycleElement()`), lehnt `Promise.all` mit `AbortError` ab
 * und niemand fängt es: „Uncaught (in promise) AbortError: The play() request
 * was interrupted by a call to pause()".
 *
 * **Das Schlucken allein reicht nicht.** LiveKit ruft im `catch` von
 * `startAudio` für JEDEN Fehler `handleAudioPlaybackFailed()` und wirft erst
 * danach: `canPlaybackAudio` kippt auf `false`, `AudioPlaybackStatusChanged
 * (false)` feuert — und Pulse zeigt daraufhin das Overlay „Audio ist
 * stummgeschaltet" (`voice.audioBlocked`), obwohl nur ein Abspielversuch
 * überholt wurde und der Ton läuft. Zurück auf „frei" kommt LiveKit nur über
 * den nächsten ERFOLGREICHEN `startAudio` (der gleicht zuerst den AudioContext
 * ab und feuert dann `true`) — der kommt von selbst erst, wenn wieder ein
 * `AudioStreamAcquired` oder ein Klick folgt. Deshalb wiederholt der Wrapper
 * einen überholten Versuch (höchstens `STARTAUDIO_WIEDERHOLUNGEN` Mal): die
 * Wiederholung ermittelt den tatsächlichen Zustand neu. Ist der Ton wirklich
 * gesperrt, antwortet sie mit `NotAllowedError`, der unverändert beim Aufrufer
 * ankommt (und `canPlaybackAudio` bleibt `false` — das Overlay bleibt). Das
 * kurze `false` zwischen Abbruch und Wiederholung liegt im selben Task (nur
 * Promise-Fortsetzungen dazwischen, `acquireAudioContext` meldet bei laufendem
 * Kontext synchron), wird also nicht gemalt. Wird derselbe Versuch dreimal
 * hintereinander überholt, bleibt der Zustand „gesperrt" stehen, bis der Nutzer
 * „Ton aktivieren" drückt — der Abbruch selbst bleibt auch dann kein Fehler.
 *
 * **Muss VOR `room.connect()` gerufen werden**: das Ereignis wird erst beim
 * Verbinden verdrahtet und liest `room.startAudio` in genau diesem Moment.
 * Alles andere als ein Abbruch kommt unverändert beim Aufrufer an.
 */
export function startAudioAbbruchfest(raum: { startAudio: () => Promise<void> }): void {
  const original = raum.startAudio;
  raum.startAudio = () => ohneAbbruch(() => original.call(raum), STARTAUDIO_WIEDERHOLUNGEN);
}
