/**
 * „Diesen Bildschirm schließen" — die reinen Regeln, ohne Laufzeit-Importe.
 *
 * Der Ablauf (Steuernder → Gerät) steht in `$lib/remote/schirmZu.ts` und
 * `$lib/devices/schirmZu.ts`; hier liegt nur, was sich ohne App prüfen lässt
 * (`pnpm test:unit`, Nodes Testläufer — Kopf von `zeigerbildPruefung.ts`).
 */

/** Die Signal-Art. Steht genauso in `_SIGNAL_KINDS`
 *  (`ws_remote_handlers.py`) und in `RemoteSignalKind` (`ws/handlers/types.ts`). */
export const SCHIRM_ZU = 'schirm_zu';

/**
 * Der Platz aus einem `schirm_zu`-Signal, oder `null`.
 *
 * Streng, weil das Signal von der Gegenseite kommt: nur eine ganze Zahl im
 * Bereich der Stream-Plätze. Alles andere wird verworfen, nicht gedeutet.
 */
export function slotAusSignal(daten: unknown, maxSlots: number): number | null {
  const slot = (daten as { slot?: unknown } | null)?.slot;
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < maxSlots
    ? slot
    : null;
}

/**
 * Wie lange Eingaben an einen schließenden Platz verworfen werden.
 *
 * Der Sidecar des Platzes beendet sich nach `stop` von selbst; bis sein
 * Prozess weg ist, weist er Eingaben ab, und `ws/handlers/remote.ts` wertet
 * eine Abweisung als Grund, die ganze Sitzung zu beenden. Danach antwortet die
 * Brücke für einen Platz ohne Sidecar harmlos (`unknown_slot`). Fünf Sekunden
 * sind reichlich für das Ende eines Prozesses — nicht gemessen.
 */
export const ABSCHIED_MS = 5_000;

/** Plätze, die gerade geschlossen werden, mit dem Zeitpunkt, bis zu dem ihre
 *  Eingaben verworfen werden. */
export class Abschiede {
  #bis = new Map<number, number>();

  markieren(slot: number, jetztMs: number): void {
    this.#bis.set(slot, jetztMs + ABSCHIED_MS);
  }

  /** Vorzeitig aufheben — wird der Platz neu belegt, gelten seine Eingaben. */
  aufheben(slot: number): void {
    this.#bis.delete(slot);
  }

  /** Sollen Eingaben an diesen Platz jetzt verworfen werden? */
  verwirft(slot: number, jetztMs: number): boolean {
    const bis = this.#bis.get(slot);
    if (bis === undefined) return false;
    if (jetztMs < bis) return true;
    this.#bis.delete(slot);
    return false;
  }
}
