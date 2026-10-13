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

/** Ist das der Abbruch eines Abspielversuchs (`play()` wurde überholt)? */
export function istAbspielAbbruch(fehler: unknown): boolean {
  return (
    typeof fehler === 'object' &&
    fehler !== null &&
    (fehler as { name?: unknown }).name === 'AbortError'
  );
}

/** Führt `aktion` aus; ein Abspiel-Abbruch endet still, jeder andere Fehler
 *  wird weitergereicht. */
async function ohneAbbruch(aktion: () => Promise<void>): Promise<void> {
  try {
    await aktion();
  } catch (fehler) {
    if (!istAbspielAbbruch(fehler)) throw fehler;
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
 * **Muss VOR `room.connect()` gerufen werden**: das Ereignis wird erst beim
 * Verbinden verdrahtet und liest `room.startAudio` in genau diesem Moment.
 * Alles andere als ein Abbruch kommt unverändert beim Aufrufer an.
 */
export function startAudioAbbruchfest(raum: { startAudio: () => Promise<void> }): void {
  const original = raum.startAudio;
  raum.startAudio = () => ohneAbbruch(original);
}
