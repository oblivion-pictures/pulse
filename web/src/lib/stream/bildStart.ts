/**
 * Das Bild einer HQ-Kachel starten, wenn WebKit es ohne Geste verweigert —
 * die reine Rechnung neben `hqStreamManager.svelte.ts`. **Importfrei** (Pflicht
 * für `pnpm test:unit`, s. CLAUDE.md).
 *
 * **Warum es das braucht (Befund 2026-10-17, TestFlight 8.1).** Seit der Ton
 * einer Übertragung in der iOS-Hülle nativ spielt (`nativerStreamTon.ts`),
 * spielt die WebView selbst keinen Ton mehr. Damit fällt eine Ausnahme weg,
 * an der das Bild hing: WebKit lässt ein `<video>` mit MediaStream ohne Geste
 * nur dann laufen, wenn das Dokument aufnimmt ODER schon Ton abspielt
 * (`MediaElementSession::playbackStateChangePermitted`, Zweig
 * `hasMediaStreamSrcObject` → `isCapturing` / `IsPlayingAudio`). Erst DANACH
 * prüft es die Sperren für Stromsparmodus und starke Wärmedrosselung
 * (`RequireUserGestureForVideoDueToLowPowerMode` /
 * `…AggressiveThermalMitigation`, gesetzt in
 * `HTMLMediaElement::initializeMediaSession`) — und die greifen auch für ein
 * stummes Video. Vorher spielte der Web-Audio-Graph der Kachel den Ton, das
 * Dokument „spielte Ton“, die Ausnahme griff. Jetzt verweigert `play()` mit
 * `NotAllowedError`, und das leere `catch` liess die Kachel ohne Bild und ohne
 * Hinweis stehen, während der native Ton lief.
 *
 * Im Simulator nachgestellt (Stromsparmodus per
 * `notifyutil -s com.apple.system.lowpowermode 1`): `play()` →
 * `NotAllowedError`; derselbe Aufruf mit laufendem AudioContext im Dokument →
 * gelingt. Ohne Stromsparmodus läuft das Bild — deshalb fiel es vor dem Bau
 * nicht auf.
 *
 * **Der Weg heraus ist eine Geste**, nichts anderes: die Ausnahme über einen
 * WebView-Ton wiederherzustellen, hiesse, die Session-Regeln des nativen Wegs
 * zu brechen (`streamTonLage.ts`). Deshalb: sofort versuchen, bei
 * Verweigerung bei der nächsten Berührung irgendwo auf der Seite erneut — und
 * die Kachel zeigt einen Knopf, damit der Nutzer weiß, dass er tippen muss.
 */

/** Was beim Start herauskam — für die Diagnose und die Kachel. */
export type BildErgebnis = 'spielt' | 'gesperrt' | 'abgebrochen' | 'fehler';

/**
 * Ein abgelehntes `play()` deuten. `NotAllowedError` = Richtlinie (braucht eine
 * Geste); `AbortError` = ein neuer `srcObject`/Ladevorgang kam dazwischen,
 * kein Grund zum Warten auf eine Geste.
 */
export function bildErgebnis(fehler: unknown): BildErgebnis {
  const name = (fehler as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError') return 'gesperrt';
  if (name === 'AbortError') return 'abgebrochen';
  return 'fehler';
}

/** Was die Rechnung vom Video-Element braucht — ein Test baut es nach. */
export interface Abspielbar {
  play(): Promise<void>;
  readonly paused: boolean;
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
}

/** Was die Rechnung vom Strom braucht. */
export interface MitSpuren {
  getVideoTracks(): readonly { readyState: string; muted: boolean }[];
  getAudioTracks(): readonly { enabled: boolean }[];
}

/**
 * Die Diagnose-Felder für eine Zeile im Bericht: ist eine Video-Spur da und
 * lebt sie, wie weit ist das Element, und was ergab `play()`.
 */
export function bildDiagnose(
  el: Abspielbar,
  strom: MitSpuren | null,
  ergebnis: BildErgebnis
): Record<string, string | number | boolean> {
  const video = strom?.getVideoTracks()[0];
  return {
    ergebnis,
    video_spur: !!video,
    video_spur_lebt: video?.readyState === 'live',
    video_spur_stumm: video?.muted ?? false,
    ton_spuren_an: strom?.getAudioTracks().filter((t) => t.enabled).length ?? 0,
    ready_state: el.readyState,
    pausiert: el.paused,
    groesse: `${el.videoWidth}x${el.videoHeight}`
  };
}

/** Wie `audio/kontextFortsetzen.ts`: welche Ereignisse als Geste zählen, hängt
 *  von der Eingabeart ab; bei einer Berührung zählt oft erst das spätere. */
const GESTEN = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

/**
 * Bei der nächsten Geste auf `ziel` erneut `play()` versuchen, bis das Bild
 * läuft. `fertig(true)` meldet den Erfolg (danach lösen sich die Zuhörer).
 * Rückgabe baut ab, ohne zu melden (Kachel zu, neuer Strom).
 */
export function aufGesteAbspielen(
  el: Abspielbar,
  ziel: EventTarget,
  fertig: (laeuft: boolean) => void
): () => void {
  let aktiv = true;
  function abbauen(): void {
    aktiv = false;
    for (const art of GESTEN) ziel.removeEventListener(art, gehoert, true);
  }
  function gelaufen(): void {
    if (!aktiv) return;
    abbauen();
    fertig(true);
  }
  function gehoert(): void {
    if (!aktiv) return;
    if (!el.paused) {
      gelaufen();
      return;
    }
    el.play().then(gelaufen, () => undefined);
  }
  for (const art of GESTEN) ziel.addEventListener(art, gehoert, true);
  return abbauen;
}
