/**
 * Querformat → Vollbild für die HQ-Kachel in der iOS-Hülle (Roadmap Punkt 27,
 * Nutzerwunsch 2026-10-17) — die reine Entscheidung neben `TileShell.svelte`.
 * **Importfrei** (Pflicht für `pnpm test:unit`, s. CLAUDE.md).
 *
 * Dreht man das Telefon quer, während eine Übertragung als Kachel läuft, geht
 * sie ins (selbst gebaute) Vollbild; zurück im Hochformat verlässt sie es.
 * Quer drehen kann die Hülle ohnehin nur mit angedocktem Stream
 * (`orientierungSperren` in `routes/app/+layout.svelte`).
 *
 * **Ausgelöst wird allein der ÜBERGANG**, nie der Zustand — sonst wäre ein im
 * Querformat verlassenes Vollbild sofort wieder da (dieselbe Falle, die der
 * alte, stillgelegte Kipp-Effekt in `TileShell` beschreibt).
 *
 * **Welche Kachel:** genau eine offene — oder bei mehreren die zuletzt
 * angetippte. Ohne Tipp bei mehreren keine: zwei Kacheln gleichzeitig im
 * Vollbild gibt es nicht, und eine geratene wäre oft die falsche.
 *
 * **Nicht bei fokussiertem Eingabefeld:** mit offener Tastatur kann das
 * Fenster breiter als hoch werden, ohne dass jemand dreht — und wer tippt,
 * will den Chat sehen, nicht das Vollbild.
 */

export type QuerAktion = 'betreten' | 'verlassen' | null;

export interface QuerLage {
  /** Steht das Gerät jetzt quer? */
  quer: boolean;
  /** Stand es beim letzten Blick quer? */
  warQuer: boolean;
  /** Ist die Kachel gerade im Vollbild (egal wie hineingekommen)? */
  imVollbild: boolean;
  /** Ist diese Kachel die gemeinte (`QuerKacheln.istZiel`)? */
  ziel: boolean;
  /** Ist ein Eingabefeld fokussiert? */
  eingabeFokussiert: boolean;
}

export function querVollbildAktion(l: QuerLage): QuerAktion {
  if (l.quer && !l.warQuer) {
    return !l.imVollbild && l.ziel && !l.eingabeFokussiert ? 'betreten' : null;
  }
  if (!l.quer && l.warQuer) return l.imVollbild ? 'verlassen' : null;
  return null;
}

/**
 * Quer oder hoch — nach der Lage des BILDSCHIRMS (`screen.orientation.type`),
 * nicht nach dem Seitenverhältnis des Fensters: das kippt auch, wenn nur die
 * Tastatur aufgeht. Fehlt die Angabe (ältere WebKits), zählt das Fenster.
 */
export function istQuer(orientierungsTyp: string | undefined, fensterQuer: boolean): boolean {
  if (orientierungsTyp) return orientierungsTyp.startsWith('landscape');
  return fensterQuer;
}

/** Ist dieses Element ein Eingabefeld (Text, Textbereich, editierbar)? */
export function istEingabe(
  el: { tagName?: string; isContentEditable?: boolean; type?: string } | null
): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const art = (el.type ?? 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(art);
}

/** Die offenen HQ-Kacheln und welche zuletzt angetippt wurde. */
export class QuerKacheln {
  readonly #offen: string[] = [];
  #letzte: string | null = null;

  anmelden(id: string): void {
    if (!this.#offen.includes(id)) this.#offen.push(id);
  }

  abmelden(id: string): void {
    const i = this.#offen.indexOf(id);
    if (i >= 0) this.#offen.splice(i, 1);
    if (this.#letzte === id) this.#letzte = null;
  }

  angetippt(id: string): void {
    if (this.#offen.includes(id)) this.#letzte = id;
  }

  /** Genau eine offen → sie; mehrere → die zuletzt angetippte, sonst keine. */
  istZiel(id: string): boolean {
    if (!this.#offen.includes(id)) return false;
    if (this.#offen.length === 1) return true;
    return this.#letzte === id;
  }
}
