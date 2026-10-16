/**
 * Auf welchem Weg spielt die Oberfläche ihre Hinweistöne ab?
 *
 * **Auf iOS-WebKit nie über ein Media-Element.** Ein hörbar gespieltes
 * `<audio>` mit endlicher Dauer meldet WebKit als „Jetzt läuft" an:
 * Sperrbildschirm und Kontrollzentrum zeigen danach eine Karte mit Zeitleiste
 * und Spulknöpfen, und das pausierte Element bleibt „zuletzt gespielt" stehen
 * (TestFlight 2.1, am iPhone des Eigentümers). Schwerer wiegt, dass WebKit für
 * ein solches Element eine NICHT mischbare Session einrichtet — die nimmt der
 * Hülle ihre Audio-Session weg, und im nativen Sprachkanal steht danach das
 * Mikrofon (Messung an `webSessionTyp` in `platform/iosSprache.ts`, Kette K1).
 * Reine Web-Audio-Wiedergabe kennt WebKit dagegen nur als Beiwerk: ohne
 * eigene Erklärung wählt es dafür `AmbientSound`, also mischbar (gelesen in
 * WebKits `MediaSessionManagerCocoa::updateSessionState`, main). Dass dabei
 * auch keine Jetzt-läuft-Karte entsteht, ist gefolgert und am Gerät zu
 * bestätigen.
 *
 * **Kein Rückfall aufs Element.** Fehlt `AudioContext`, bleibt der Ton aus —
 * ein Rückfall brächte genau die Anzeige und den Session-Diebstahl zurück,
 * gegen die dieser Weg steht.
 *
 * Desktop, Android und jeder andere Browser behalten das Media-Element, wie
 * vorher (Eigentümer-Grundsatz 2026-10-16).
 *
 * Importfrei, damit Nodes Läufer es prüfen kann (CLAUDE.md, `pnpm test:unit`).
 */

export type TonWeg = 'element' | 'webaudio' | 'still';

export function tonWeg(umgebung: { iosWebKit: boolean; audioContextDa: boolean }): TonWeg {
  if (!umgebung.iosWebKit) return 'element';
  return umgebung.audioContextDa ? 'webaudio' : 'still';
}

/**
 * Welche Dateiendungen der gebündelten Töne der Weg der Reihe nach versucht.
 *
 * Auf iOS zuerst AAC (`.m4a`): ob WebKit auf iOS Ogg Vorbis per
 * `decodeAudioData` dekodiert, ist nicht belegt — AAC dekodiert es sicher.
 * `.ogg` bleibt als zweiter Versuch stehen, kostet aber nur dann etwas, wenn
 * ein `.m4a` fehlt. Der Element-Weg bleibt unverändert bei `.ogg` → `.mp3`.
 */
export function tonEndungen(weg: TonWeg): readonly string[] {
  return weg === 'webaudio' ? ['m4a', 'ogg'] : ['ogg', 'mp3'];
}
