/**
 * Kacheln, die der Nutzer gerade selbst geschlossen hat und die deshalb NICHT
 * von selbst wieder aufgehen dürfen.
 *
 * **Der Fall** (Live-Lauf 2026-10-16, 0.1.118): „Diesen Bildschirm schließen"
 * (`$lib/remote/schirmZu.ts`) macht Kachel und Fenster sofort zu — der Server
 * führt den Strom aber noch bis zu 3 s als laufend (Poller von media-svc). In
 * dieser Zeit sah die Automatik in `VoiceChannelView.svelte` („ein weiterer
 * Bildschirm eines Streamers, den ich schon anschaue, geht daneben auf") einen
 * laufenden Strom ohne offene Kachel und öffnete sie wieder — drei- bis
 * sechsmal hintereinander, jedes Mal mit WHEP 404.
 *
 * **Warum die Sperre am Verschwinden aus der Liste hängt:** der Strom trägt in
 * der Liste nur Streamer und Platz, keine eigene Kennung. Ist er einmal weg,
 * war er beendet, und ein späterer Strom auf demselben Platz ist ein neuer —
 * der darf wieder von selbst aufgehen. Wer den Bildschirm ausdrücklich wieder
 * holt, hebt die Sperre sofort auf (`$lib/devices/schirme.svelte.ts`).
 *
 * Importfrei (Nodes Testläufer, `pnpm test:unit`); die Instanz unten trägt
 * keinen reaktiven Zustand — gelesen wird sie nur in `untrack`.
 */

/** Sicherheitsnetz: meldet der Server das Ende nie, fällt die Sperre hiernach. */
export const ABBESTELLT_MS = 30_000;

export class Abbestellungen {
  /** Schlüssel `<kanal>::<kachel>` → Zeitpunkt, bis zu dem gesperrt ist. */
  #bis = new Map<string, number>();

  #k(kanal: string, kachel: string): string {
    return `${kanal}::${kachel}`;
  }

  abbestellen(kanal: string, kachel: string, jetztMs: number): void {
    this.#bis.set(this.#k(kanal, kachel), jetztMs + ABBESTELLT_MS);
  }

  aufheben(kanal: string, kachel: string): void {
    this.#bis.delete(this.#k(kanal, kachel));
  }

  gesperrt(kanal: string, kachel: string, jetztMs: number): boolean {
    const k = this.#k(kanal, kachel);
    const bis = this.#bis.get(k);
    if (bis === undefined) return false;
    if (jetztMs < bis) return true;
    this.#bis.delete(k);
    return false;
  }

  /** Mit den gerade gelisteten Kacheln eines Kanals abgleichen: was nicht mehr
   *  gelistet ist, war beendet — seine Sperre fällt. */
  abgleichen(kanal: string, gelistet: ReadonlySet<string>): void {
    const praefix = `${kanal}::`;
    for (const k of [...this.#bis.keys()]) {
      if (k.startsWith(praefix) && !gelistet.has(k.slice(praefix.length))) this.#bis.delete(k);
    }
  }
}

export const abbestellt = new Abbestellungen();
