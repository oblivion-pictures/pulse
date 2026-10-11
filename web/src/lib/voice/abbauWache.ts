/**
 * **Ein Auflegen, das noch läuft — und ein Beitritt, der darauf wartet**
 * (iOS-Bughunt 2 vom 2026-10-11, B2).
 *
 * Auf dem nativen Weg nimmt `disconnect` den Spiegel sofort zurück
 * (`NativerRaum.verlassen` setzt `aktiv = false`) und wartet dann auf die
 * Hülle; erst danach räumt `#teardown` den Store ab. Ein `connect` in diesem
 * Fenster sah keinen Raum mehr, begann seinen Beitritt — und das späte
 * `#teardown` entwertete ihn (`#connectGen++`) und setzte alles auf
 * „getrennt". Meist tat der Tipp still nichts; war die Hülle langsam, stand
 * danach ein Raum mit offenem Mikrofon, den die Oberfläche nicht kannte.
 *
 * Die Wache hält den laufenden Abbau fest, und `connect` wartet auf ihn,
 * bevor es seinen Beitritt beansprucht. **Nur wenn einer läuft** — sonst
 * kostete schon das Warten auf ein erfülltes Versprechen einen Mikrotask, und
 * `connect` setzt `Connecting` bewusst ohne Verzug (Bughunt 2, N1).
 *
 * Importfrei, damit Nodes Läufer es prüfen kann (CLAUDE.md, `pnpm test:unit`).
 */
export class AbbauWache {
  #laufend: Promise<void> | null = null;

  /** Läuft gerade ein Abbau? */
  get laeuft(): boolean {
    return this.#laufend !== null;
  }

  /** `abbau` ausführen und festhalten, bis er durch ist. Sein Fehler geht an
   *  den Rufer weiter. */
  async fahren(abbau: () => Promise<void>): Promise<void> {
    const p = abbau();
    this.#laufend = p;
    try {
      await p;
    } finally {
      if (this.#laufend === p) this.#laufend = null;
    }
  }

  /** Auf den laufenden Abbau warten. Ob er gelang, zählt hier nicht — der
   *  Wartende will nur, dass er vorbei ist. */
  async abwarten(): Promise<void> {
    await this.#laufend?.catch(() => undefined);
  }
}
