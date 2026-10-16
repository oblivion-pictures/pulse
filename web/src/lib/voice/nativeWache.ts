import { spracheWacheBeobachten } from '$lib/platform/iosSpracheWache';
import { nativeWacheDa } from '$lib/platform/iosSpracheWeiche';

/**
 * Der Spiegel des Mikrofon-Wächters der Hülle (`SpracheMikroWache.swift`) im
 * nativen Raum — aus `nativerRaum.svelte.ts` herausgelöst (Grössen-Policy).
 * **Ohne Runes**: der sichtbare Stand `mikroTot` liegt im Raum, hierher kommt
 * nur der Rückruf.
 *
 * **Warum der Beitrittston wartet.** Er kam bis zum 2026-10-17 sofort nach dem
 * Beitritt — oft, bevor die Aufnahme lief, und genau in dem Moment, in dem
 * WebKit für einen Ton eine Session einrichtet (Kette K1 der Befundakte). Jetzt
 * erst, wenn das Mikrofon Puffer liefert, höchstens aber nach `frist` ms: ein
 * Ton, der nie kommt, wäre ein schlechteres Zeichen als ein später.
 */
export class NativeWache {
  #abmelden: (() => void) | null = null;
  #bereit = false;
  #wartende: (() => void)[] = [];
  readonly #beiTot: (tot: boolean) => void;

  constructor(beiTot: (tot: boolean) => void) {
    this.#beiTot = beiTot;
  }

  /** Vor dem Beitritt: die Hülle meldet „bereit" oft noch während er läuft. */
  beobachten(): void {
    this.abmelden();
    this.#bereit = false;
    this.#abmelden = spracheWacheBeobachten({
      bereit: () => this.#bereitGesehen(),
      tot: (tot) => this.#beiTot(tot)
    });
  }

  abmelden(): void {
    this.#abmelden?.();
    this.#abmelden = null;
    this.#bereitGesehen();
  }

  /** Bis das Mikrofon liefert — sofort ohne Wächter im Bau. */
  bereitAbwarten(frist = 3000): Promise<void> {
    if (this.#bereit || !nativeWacheDa()) return Promise.resolve();
    return new Promise((fertig) => {
      const uhr = setTimeout(fertig, frist);
      this.#wartende.push(() => {
        clearTimeout(uhr);
        fertig();
      });
    });
  }

  #bereitGesehen(): void {
    this.#bereit = true;
    const w = this.#wartende;
    this.#wartende = [];
    for (const f of w) f();
  }
}
