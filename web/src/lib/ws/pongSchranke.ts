/**
 * „Hat der Server alles verarbeitet, was ich bis eben geschickt habe?" —
 * beantwortet über Ping und Pong.
 *
 * Der Gateway arbeitet die Rahmen eines Sockets streng der Reihe nach ab
 * (`routes/ws_ops.py`: ein Rahmen, `await handler`, dann der nächste) und
 * beantwortet jeden `ping` sofort mit `pong` (`ws_ops_handlers.handle_ping`).
 * Kommt der Pong auf einen Ping, der NACH einem `subscribe` ging, ist das Abo
 * am Server eingetragen — erst ab dann fängt ein REST-Nachholen jede
 * Nachricht, denn was danach veröffentlicht wird, kommt live.
 *
 * Gebraucht beim Neuaufbau: das Abo geht im `open` raus, der Server liest es
 * aber erst nach dem `ready`; ein Nachholen schon beim `hello` konnte vor dem
 * Abo fertig sein, und eine Nachricht dazwischen fiel durch beide Wege.
 *
 * Gezählt wird jeder Ping (auch der Herzschlag), weil die Pongs keine Nummer
 * tragen: der n-te Pong gehört zum n-ten Ping. Importfrei (Test:
 * `nachhol-netz`).
 */
export class PongSchranke {
  #gesendet = 0;
  #empfangen = 0;
  #wartend: { ziel: number; fn: () => void }[] = [];

  /** Ein Ping ging raus. */
  gesendet(): void {
    this.#gesendet += 1;
  }

  /** `fn` laufen lassen, sobald der zuletzt gezählte Ping beantwortet ist —
   *  deckt alles, was VOR ihm verschickt wurde. Ist er es schon, sofort. */
  nach(fn: () => void): void {
    if (this.#empfangen >= this.#gesendet) {
      fn();
      return;
    }
    this.#wartend.push({ ziel: this.#gesendet, fn });
  }

  /** Ein Pong kam an. */
  empfangen(): void {
    this.#empfangen += 1;
    const faellig = this.#wartend.filter((w) => w.ziel <= this.#empfangen);
    if (!faellig.length) return;
    this.#wartend = this.#wartend.filter((w) => w.ziel > this.#empfangen);
    for (const w of faellig) w.fn();
  }

  /** Neuer Socket: Zählung von vorn, Wartende verfallen (ihr Socket ist weg,
   *  der Nachfolger holt selbst nach). */
  zuruecksetzen(): void {
    this.#gesendet = 0;
    this.#empfangen = 0;
    this.#wartend = [];
  }
}
