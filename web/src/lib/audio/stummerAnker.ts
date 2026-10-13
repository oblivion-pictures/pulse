/**
 * Stummer Anker für den Web-Audio-Weg — ohne Import (Pflicht für
 * `pnpm test:unit`, s. CLAUDE.md).
 *
 * Läuft der Ton eines fernen Tracks über einen eigenen Web-Audio-Zug
 * (Lautstärke über 100 %, Make-up-Gain), braucht Chromium trotzdem ein
 * `<audio>`-Element, das denselben Strom abspielt: ohne es liefert ein
 * `MediaStreamAudioSourceNode` für WebRTC-Tracks nichts (bekannter
 * Chromium-Fehler, s. `anchor` in `voice/audioElements.ts`). Das Element ist
 * nur dieser Anker — hören soll man allein den Zug, das Element bleibt STUMM.
 *
 * **Der Anker darf nicht per `track.attach()` entstehen.** LiveKit führt jedes
 * so angehängte Element in `track.attachedElements`, und `room.startAudio()`
 * setzt für JEDES davon `muted = false` und spielt es ab (`livekit-client`,
 * `Room.startAudio`). `startAudio` läuft nicht nur beim Beitritt: LiveKit ruft
 * es selbst, sobald ein eigener Audio-Strom steht (`AudioStreamAcquired`:
 * Mikrofon, Ton der eigenen Bildschirmfreigabe) und unter iOS beim
 * Sichtbarkeitswechsel; Pulse ruft es bei „Ton aktivieren“ und wiederholt es
 * nach einem überholten Versuch (`audio/abspielen.ts`). Ein per `attach()`
 * angehängter, von Pulse stumm geschalteter Anker war danach hörbar — der Ton
 * lief doppelt: einmal übers Element, einmal über den Zug. Ein Element, das
 * LiveKit nicht kennt, fasst `startAudio` nicht an.
 *
 * Die Gegenseite (`attach()`, Element hörbar) bleibt dort richtig, wo das
 * Element selbst der hörbare Weg ist: mobil, im Anruf, als Rückfall der
 * Bildschirmfreigabe, wenn der Web-Audio-Zug nicht zustande kommt.
 */

/** Was der Anker vom Element braucht — ein Test kann es durch einen Nachbau ersetzen. */
export type AnkerElement = Pick<
  HTMLAudioElement,
  'srcObject' | 'muted' | 'autoplay' | 'play' | 'pause'
>;

/** `el` zum stummen Anker für `stream` machen und spielen lassen. Stumm wird
 *  VOR dem Strom gesetzt, damit nie ein hörbarer Augenblick entsteht. */
export function ankerBefestigen(el: AnkerElement, stream: MediaStream): void {
  el.muted = true;
  el.autoplay = true;
  el.srcObject = stream;
  // Ein überholtes play() ist folgenlos, der nächste Aufruf spielt (`GastTon.fortsetzen`,
  // `enableAudio` der Kachel). Eine echte Ablehnung ließe den Zug in Chromium stumm
  // (ohne spielendes Element liefert die Quelle nichts); bei einem stummen Element
  // kommt sie aber nicht vor, stumm abspielen scheitert an keiner Autoplay-Sperre.
  void el.play().catch(() => undefined);
}

/** Den Anker anhalten und vom Strom trennen. Das Element selbst bleibt
 *  stehen (wer es angelegt hat, entfernt es). */
export function ankerLoesen(el: AnkerElement): void {
  el.pause();
  el.srcObject = null;
}
