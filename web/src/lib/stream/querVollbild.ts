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
 * frühere, stillgelegte Kipp-Effekt in `TileShell` hatte, bis er entfernt
 * wurde: ein Effekt, der `isFullscreen` liest, fordert nach dem Verlassen
 * sofort wieder an).
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

/** Was `istQuer` über die Lage weiss (Werte in CSS-Pixeln). */
export interface LageMasse {
  /** Breite des Layout-Viewports (`documentElement.clientWidth`). */
  breite: number;
  /** Kürzere Bildschirmseite (`min(screen.width, screen.height)`), 0 = unbekannt. */
  kurzeSeite: number;
  /** `screen.orientation.type` — fehlt in älteren WebKits. */
  typ?: string;
  /** Fenster breiter als hoch (`(orientation: landscape)`). */
  fensterQuer: boolean;
}

/**
 * Quer oder hoch — zuerst nach der BREITE gegen die kurze Bildschirmseite:
 * quer ist das Fenster breiter, als der Bildschirm hochkant überhaupt ist.
 * Die offene Tastatur nimmt nur Höhe weg und kippt das nicht (am blossen
 * Seitenverhältnis des Fensters schon). `screen.orientation.type` ist erst der
 * Rückfall: in einer WKWebView mit Element-Vollbild ist er nicht verlässlich
 * (WebKit-Bug 280757, von Dritten gemessen: `requestFullscreen` löst dort
 * falsche Lage-Ereignisse aus) — und die Hülle hat Element-Vollbild.
 * Nebenfolge am iPad: ein schmales Split-View-Fenster zählt als hoch.
 */
export function istQuer(m: LageMasse): boolean {
  if (m.breite > 0 && m.kurzeSeite > 0) return m.breite > m.kurzeSeite;
  if (m.typ) return m.typ.startsWith('landscape');
  return m.fensterQuer;
}

/**
 * Das Übergangs-Gedächtnis einer Kachel (`warQuer`). `schritt` bei jedem
 * Lage-Ereignis; `abgleichen` nach einem Wechsel des echten Vollbilds, ohne
 * etwas auszulösen — damit eine Lesung mitten im Vollbild-Wechsel den nächsten
 * echten Übergang nicht verschluckt.
 */
export class QuerVerlauf {
  #warQuer: boolean;

  constructor(quer: boolean) {
    this.#warQuer = quer;
  }

  schritt(l: Omit<QuerLage, 'warQuer'>): QuerAktion {
    const aktion = querVollbildAktion({ ...l, warQuer: this.#warQuer });
    this.#warQuer = l.quer;
    return aktion;
  }

  abgleichen(quer: boolean): void {
    this.#warQuer = quer;
  }
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
