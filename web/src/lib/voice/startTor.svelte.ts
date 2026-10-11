/**
 * Das Tor vor jedem automatischen Beitritt: offen erst, wenn der Start durch
 * ist — die App entsperrt, der Abgleich mit der Hülle gelaufen, das
 * Wiederaufnehmen und der Auto-Connect entschieden (`startBeitritte.ts`).
 * Warum es das braucht: `startBeitritt.ts`, Punkt 1.
 *
 * **Bewusst ohne Import.** Gefragt wird es auch vom WS-Handler für
 * `voice_pull` (`ws/handlers/voice.ts`), und der lädt den Voice-Store mit
 * `livekit-client` absichtlich erst bei Bedarf nach.
 */
class StartTor {
  /** Reaktiv — die Kanal-Route fragt erneut, sobald es aufgeht. */
  fertig = $state(false);
  #warteliste: (() => void)[] = [];

  /** Zu Beginn jedes Starts. Auch nach einem Kontowechsel im selben
   *  Dokument: was für das vorige Konto entschieden war, gilt nicht. */
  schliessen(): void {
    this.fertig = false;
  }

  oeffnen(): void {
    this.fertig = true;
    for (const weiter of this.#warteliste.splice(0)) weiter();
  }

  /** Für Wege ohne Reaktivität (WS-Handler): wartet, bis das Tor offen ist. */
  warten(): Promise<void> {
    if (this.fertig) return Promise.resolve();
    return new Promise((weiter) => this.#warteliste.push(weiter));
  }
}

export const startTor = new StartTor();
