/**
 * Startet das Bild einer HQ-Kachel mit nativem Ton nach, wenn es pausiert
 * steht, obwohl niemand es angehalten hat — die reine Rechnung neben
 * `hqStreamManager.svelte.ts`. **Importfrei** (Pflicht für `pnpm test:unit`,
 * s. CLAUDE.md).
 *
 * **Warum (Hypothese, gefolgert, nicht gemessen):** seit dem nativen
 * Stream-Ton aktiviert die Hülle eine eigene AVAudioSession
 * (`StreamTonSitzung.swift`). Meldet iOS WebKit daraufhin eine
 * Audio-Unterbrechung, ruft WebKits `PlatformMediaSession::beginInterruption`
 * an jedem Medien-Element `suspendPlayback()` auf — auch am stummen `<video>`
 * mit MediaStream, das dann mit `pause` stehen bleibt. Unser Code rief
 * `play()` bisher nur beim Anhängen des Stroms; eine spätere Pause bemerkte
 * niemand. Ob die Unterbrechung am Gerät wirklich eintritt, zeigt erst der
 * Bericht (`bild_pausiert_*` in `iosTonDiagnose.ts`).
 *
 * Unsere Kachel pausiert ihr Video selbst nie (keine Bedienelemente am
 * `<video>`, das Lösen setzt nur `srcObject = null` und baut die Wache vorher
 * ab) — jede Pause während der Wache ist also fremd.
 */

/** Höchstens ein Nachstart je Abstand — Schleifenschutz, falls WebKit jedes
 *  `play()` sofort wieder anhält. **Gesetzt, nicht gemessen.** */
export const WACHE_ABSTAND_MS = 1000;

/** Ereignisse am Video, nach denen es stehen kann. `suspend`/`stalled` kommen
 *  auch im Normalbetrieb — dann läuft das Video, und die Wache tut nichts. */
const VIDEO_EREIGNISSE: Record<string, string> = {
  pause: 'pausiert_von_webkit',
  suspend: 'pausiert_nach_suspend',
  stalled: 'pausiert_nach_stalled'
};

const VIDEO_EREIGNIS_ARTEN = Object.keys(VIDEO_EREIGNISSE);

/** Was die Wache vom Video braucht — ein Test baut es nach. */
export interface Beobachtbar extends EventTarget {
  readonly paused: boolean;
}

/** Was die Wache von der Seite braucht (`document`). */
export interface Seite extends EventTarget {
  readonly visibilityState: string;
}

export interface BildWache {
  /** Steht das Bild (und ist die Seite vorn), nachstarten — gedrosselt. */
  anstossen(grund: string): void;
  /** Alle Zuhörer und den Zeitgeber abbauen. */
  abbauen(): void;
}

/**
 * Wache an `el` hängen. `nachstarten(grund)` läuft, wenn das Video pausiert
 * steht und die Seite sichtbar ist — höchstens einmal je `abstandMs`; ein
 * Anstoss innerhalb des Abstands wird ans Ende verschoben, nicht verworfen.
 * Im Hintergrund nie: dort pausiert WebKit absichtlich, und die Rückkehr
 * nach vorn stösst selbst an.
 */
export function bildWache(
  el: Beobachtbar,
  seite: Seite,
  nachstarten: (grund: string) => void,
  jetzt: () => number = Date.now,
  abstandMs = WACHE_ABSTAND_MS
): BildWache {
  let aktiv = true;
  let letzter = -Infinity;
  let spaeter: ReturnType<typeof setTimeout> | undefined;

  function anstossen(grund: string): void {
    if (!aktiv || !el.paused || seite.visibilityState !== 'visible') return;
    const rest = letzter + abstandMs - jetzt();
    if (rest > 0) {
      spaeter ??= setTimeout(() => {
        spaeter = undefined;
        anstossen(grund);
      }, rest);
      return;
    }
    letzter = jetzt();
    nachstarten(grund);
  }

  const amVideo = (e: Event): void => anstossen(VIDEO_EREIGNISSE[e.type]);
  const sichtbar = (): void => anstossen('pausiert_nach_vordergrund');
  for (const art of VIDEO_EREIGNIS_ARTEN) el.addEventListener(art, amVideo);
  seite.addEventListener('visibilitychange', sichtbar);

  return {
    anstossen,
    abbauen() {
      aktiv = false;
      clearTimeout(spaeter);
      spaeter = undefined;
      for (const art of VIDEO_EREIGNIS_ARTEN) el.removeEventListener(art, amVideo);
      seite.removeEventListener('visibilitychange', sichtbar);
    }
  };
}
