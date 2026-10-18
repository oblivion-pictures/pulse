/**
 * Läuft ein HQ-Stream gerade im eigenen Player-Fenster (`pulse-player`)?
 *
 * Die reine Rechnung zu drei Stellen, die dieselbe Antwort brauchen und sonst
 * auseinanderlaufen würden: das Stream-Raster lässt solche Ströme weg
 * (`StreamGrid.svelte`), der Hintergrund-Host blendet ihren Player aus statt
 * ihn als Eckfenster schweben zu lassen (`HqStreamBackgroundHost.svelte`), und
 * die Teilnehmer-Kachel zeigt das Abzeichen „Fenster“
 * (`FensterAbzeichen.svelte`).
 *
 * **Bewusst importfrei** (Unit-Test-Falle, CLAUDE.md „Frontend“): die
 * Sitzungen selbst kommen aus `store.svelte.ts`, das Runen enthält und unter
 * Nodes Testläufer nicht lädt. Hier steht nur, was aus ihren Feldern folgt.
 */

/** Der Ausschnitt einer `NativePlayerSession`, an dem die Antwort hängt. */
export interface FensterLage {
  readonly phase: string;
  /** P2P-Fenster der Fernsteuerung — hängt an keiner Kachel. */
  readonly direkt: boolean;
}

/**
 * Ersetzt das Fenster die Kachel dieses Stroms?
 *
 * **Erst ab `playing`, nicht schon beim Öffnen.** Solange das Fenster noch
 * hochkommt, hält die Kachel die Browser-Verbindung und fällt bei einem
 * gescheiterten Start nahtlos auf `<video>` zurück (`WhepPlayer.svelte`) —
 * verschwände sie vorher, sähe der Zuschauer in dieser Zeit gar nichts. Dieselbe
 * Schwelle nehmen die Abklemmung der Browser-Verbindung (`HqStreamKeepAlive`)
 * und das Ausblenden der Bedienleiste (`hideDock`), damit alle drei im selben
 * Augenblick umschalten.
 *
 * **Direktfenster zählen nicht**: sie haben nie eine Kachel gehabt, die sie
 * ersetzen könnten (`nativePlayerSessions.closeExcept`).
 */
export function laeuftImFenster(s: FensterLage | null | undefined): boolean {
  return !!s && !s.direkt && s.phase === 'playing';
}

/**
 * Die Fenster unter `sitzungen`, die gerade ein Bild zeigen — Direktfenster
 * eingeschlossen: für das Abzeichen zählt jedes Fenster, das man nach vorne
 * holen kann, nicht nur eines, das eine Kachel ersetzt.
 */
export function offeneFenster<T extends FensterLage>(sitzungen: readonly T[]): T[] {
  return sitzungen.filter((s) => s.phase === 'playing');
}

/** Wessen Stream-Chat als Seitenleiste offen sein soll (`fensterChat.svelte.ts`). */
export interface ChatWunsch {
  readonly channelId: string;
  readonly userId: string;
}

/**
 * Der Streamer, dessen Chat die Seitenleiste in `channelId` zeigt — oder `null`.
 *
 * Nur, solange mindestens eines seiner Fenster läuft: geht das letzte zu, kommt
 * die Kachel zurück und bringt ihren eigenen Chat mit; eine Seitenleiste
 * daneben wäre derselbe Chat zweimal.
 */
export function seitenleistenStreamer(
  wunsch: ChatWunsch | null,
  channelId: string,
  fensterDesStreamers: readonly FensterLage[]
): string | null {
  if (!wunsch || wunsch.channelId !== channelId) return null;
  return offeneFenster(fensterDesStreamers).length > 0 ? wunsch.userId : null;
}
