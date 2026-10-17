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
 * **Der Weg heraus ist die Ausnahme selbst:** solange eine native Kachel
 * spielt, hält die Seite einen unhörbaren AudioContext (`stummerKontext.ts`),
 * und zwar nur unter WebKits `ambient` (Halter `streamton`), sodass er die
 * Session-Regeln des nativen Wegs nicht bricht. Verweigert WebKit trotzdem,
 * wartet {@link bildAnlaufen} auf den Kontext und versucht es erneut — ohne
 * Geste (Eigentümer-Entscheid: keine Knöpfe zum Antippen). Parallel dazu
 * startet ab dem ersten Versuch jede Berührung irgendwo das Bild erneut
 * ({@link aufGesteAbspielen}) — auch dann, wenn WebKit gar nicht antwortet.
 * Erst wenn alles scheitert, zeigt die Kachel zusätzlich den Knopf.
 */

/** Was beim Start herauskam — für die Diagnose und die Kachel. */
export type BildErgebnis = 'spielt' | 'gesperrt' | 'abgebrochen' | 'fehler' | 'haengt';

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

/** Abstände der Wiederholungen, nachdem der unhörbare Kontext läuft: WebKit
 *  meldet den Ton des Dokuments erst, wenn der Kontext gerendert hat. Gemessen
 *  ist nur, dass es nach 1,5 s Laufzeit jedes Mal gelang (Simulator, 5 Läufe);
 *  die kürzeren Stufen sind Annahme und kosten nur einen weiteren Versuch. */
export const NACH_KONTEXT_MS = [150, 350, 700, 1500] as const;

/**
 * Wie lange {@link bildAnlaufen} höchstens auf etwas wartet, das WebKit nicht
 * zusagt. **Gesetzt, nicht gemessen.** Grund: `AudioContext.resume()` bleibt in
 * WebKit offen, solange der Kontext nicht starten darf (die Zusage wird erst
 * beim Übergang nach `running` eingelöst, aus dem WebKit-Quelltext gefolgert,
 * nicht am Gerät beobachtet), und `play()` an einem MediaStream sagt erst zu,
 * wenn ein Bild da ist. Ohne Frist hinge die Kachel dann ewig — weder Bild
 * noch Knopf noch Diagnose. Anlass: TestFlight 11.1 zeigte auch mit beiden
 * Fixes auf main kein Bild (2026-10-17); ob WebKit dort sperrte oder hing, ist
 * nicht gemessen — `stream_bild_start` erreichte den Server bis dahin nie.
 */
export const FRISTEN = { kontext: 2000, play: 5000 } as const;

/** `p` oder nach `ms` der Ersatzwert — der Zeitgeber wird immer abgeräumt. */
function mitFrist<T>(p: Promise<T>, ms: number, ersatz: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const ablauf = new Promise<T>((r) => {
    t = setTimeout(() => r(ersatz), ms);
  });
  return Promise.race([p, ablauf]).finally(() => clearTimeout(t));
}

/**
 * `play()` versuchen; verweigert WebKit (`gesperrt`), auf den unhörbaren
 * Kontext warten (`stummerKontext.ts`) und in {@link NACH_KONTEXT_MS} erneut.
 * Der erste Versuch läuft SYNCHRON an — aus einem Knopf heraus zählt er als
 * Geste. `noch()` = gilt der Versuch noch (Kachel offen, dasselbe Element)?
 * Jedes Warten auf WebKit ist durch {@link FRISTEN} begrenzt: ein `play()`
 * ohne Antwort ergibt `haengt`, ein Kontext ohne Antwort zählt als nicht da.
 */
export async function bildAnlaufen(
  el: Abspielbar,
  kontextBereit: () => Promise<boolean>,
  warten: (ms: number) => Promise<void>,
  noch: () => boolean,
  fristen: { kontext: number; play: number } = FRISTEN
): Promise<BildErgebnis> {
  const versuch = (): Promise<BildErgebnis> =>
    mitFrist(
      el.play().then(
        () => 'spielt' as const,
        (e: unknown) => bildErgebnis(e)
      ),
      fristen.play,
      'haengt'
    );
  let ergebnis = await versuch();
  if (ergebnis !== 'gesperrt') return ergebnis;
  if (!(await mitFrist(kontextBereit(), fristen.kontext, false))) return ergebnis;
  for (const ms of NACH_KONTEXT_MS) {
    await warten(ms);
    if (!noch()) return ergebnis;
    ergebnis = await versuch();
    if (ergebnis !== 'gesperrt') return ergebnis;
  }
  return ergebnis;
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
