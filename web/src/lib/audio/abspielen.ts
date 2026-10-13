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

/** Entscheidung nach einem Fehler: `bisher` = wie oft schon wiederholt wurde,
 *  `erlaubt` = wie oft insgesamt wiederholt werden darf, `lebt` = gibt es noch
 *  etwas, das eine Wiederholung betreffen dürfte (ein abgebauter Raum nicht). */
export function folgeNachFehler(
  fehler: unknown,
  bisher: number,
  erlaubt: number,
  lebt = true
): FolgeNachFehler {
  if (!istAbspielAbbruch(fehler)) return 'weiterreichen';
  return lebt && bisher < erlaubt ? 'wiederholen' : 'verwerfen';
}

/** Führt `aktion` aus; ein Abspiel-Abbruch endet still (nach höchstens
 *  `erlaubt` Wiederholungen, und nur solange `lebt()` gilt), jeder andere
 *  Fehler wird weitergereicht. */
async function ohneAbbruch(
  aktion: () => Promise<void>,
  erlaubt = 0,
  lebt: () => boolean = () => true
): Promise<void> {
  for (let bisher = 0; ; bisher++) {
    try {
      await aktion();
      return;
    } catch (fehler) {
      const folge = folgeNachFehler(fehler, bisher, erlaubt, lebt());
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
 * (false)` feuert, und Pulse zeigt das Overlay „Audio ist stummgeschaltet"
 * (`voice.audioBlocked`), obwohl nur ein Abspielversuch überholt wurde und der
 * Ton läuft. Von selbst kippt es erst zurück, wenn ein späterer Abspielversuch
 * gelingt (ein weiteres `startAudio`, ein neu angehängtes Element).
 *
 * Deshalb wiederholt der Wrapper einen überholten Versuch, höchstens
 * `STARTAUDIO_WIEDERHOLUNGEN` Mal. **Die Wiederholung ist ein vollständiger
 * `startAudio()`, kein bloßes Nachmessen:** sie schaltet jedes angehängte
 * Element wieder laut (`muted = false`) und spielt es erneut ab, bei Bedarf
 * legt sie einen AudioContext an, und LiveKit loggt je Versuch `could not
 * playback audio` als Warnung (bis zu dreimal). Dafür stellt sie den
 * tatsächlichen Zustand her: ist der Ton wirklich gesperrt, antwortet sie mit
 * `NotAllowedError`; der kommt unverändert beim Aufrufer an, und
 * `canPlaybackAudio` bleibt `false`. Bei laufendem AudioContext liegt das
 * kurze `false` dazwischen im selben Task (nur Promise-Fortsetzungen,
 * `acquireAudioContext` meldet dann synchron) und wird nicht gemalt. Wird
 * derselbe Versuch dreimal überholt, endet `startAudio` trotzdem ohne Fehler,
 * und das Overlay bleibt, bis ein späterer Abspielversuch gelingt (etwa „Ton
 * aktivieren").
 *
 * **Nur auf einem lebenden Raum.** Ein möglicher Überholer ist der Abbau des
 * Raums selbst (Auflegen, Kanalwechsel): er hängt die Elemente ab, schließt den
 * AudioContext und setzt den Zustand auf `disconnected`. Eine Wiederholung
 * danach legte einen neuen Kontext an, den niemand mehr schließt. Darum wird
 * nur wiederholt, solange `raum.state !== 'disconnected'`.
 *
 * **Muss VOR `room.connect()` gerufen werden**: das Ereignis wird erst beim
 * Verbinden verdrahtet und liest `room.startAudio` in genau diesem Moment.
 * Alles andere als ein Abbruch kommt unverändert beim Aufrufer an.
 */
export function startAudioAbbruchfest(raum: {
  startAudio: () => Promise<void>;
  /** `ConnectionState` des LiveKit-Raums; fehlt er, gilt der Raum als lebend. */
  state?: string;
}): void {
  const original = raum.startAudio;
  raum.startAudio = () =>
    ohneAbbruch(
      () => original.call(raum),
      STARTAUDIO_WIEDERHOLUNGEN,
      () => raum.state !== 'disconnected'
    );
}
