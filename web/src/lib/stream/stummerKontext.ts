/**
 * Ein unhörbarer AudioContext, solange in der iOS-Hülle eine Kachel ihren Ton
 * nativ spielt — damit WebKit ihr BILD ohne Geste startet. **Importfrei**
 * (Pflicht für `pnpm test:unit`, s. CLAUDE.md); der Kontext wird hineingereicht.
 *
 * **Warum** (Befund 2026-10-17, `bildStart.ts`): WebKit lässt ein `<video>` mit
 * MediaStream im Stromsparmodus nur dann ohne Geste laufen, wenn das Dokument
 * Ton abspielt. Seit der Ton nativ läuft, tut es das nicht mehr. Ein Knopf zum
 * Antippen ist keine Lösung (Eigentümer-Entscheid: keine Knöpfe, die man erst
 * drücken muss, „Ton aktivieren“ ist aus demselben Grund weg) — also spielt
 * die Seite selbst „Ton“, den niemand hört.
 *
 * **Was als Ton zählt, im Simulator gemessen (Stromsparmodus an, iOS 26.3):**
 * ein laufender Kontext ohne Quelle, ein Oszillator hinter Gain 0 und eine
 * ConstantSource mit Wert 0 zählen NICHT (`play()` → NotAllowedError) — WebKit
 * wertet einen Pfad, der nur Nullen schreibt, als still. Eine ConstantSource
 * mit 1e-20, 1e-9, 1e-6 oder 1e-4 zählt, jede. Es genügt also irgendein Wert
 * ungleich null. Gewählt ist {@link STUMMER_PEGEL}: Gleichspannung (eine
 * konstante Auslenkung ist kein Schall — es schwingt nichts) und kleiner als
 * ein halber Schritt eines 24-bit-Wandlers (2^-24 ≈ 6e-8), am Ausgang also 0.
 * Der eingebaute Weg (1e-8) ist im Simulator eigens nachgemessen.
 *
 * **Session:** der Kontext läuft nur, solange der Halter `streamton` WebKit auf
 * `ambient` hält (`nativerStreamTon.ts` schaltet beides zusammen, Halter
 * zuerst) — eine mischbare Session, die dem nativen Ton und LiveKit nichts
 * wegnimmt und nie „Jetzt läuft“-App wird. Ohne `ambient` gäbe es den Kontext
 * nicht: dann wäre er ein nicht mischbarer WebView-Ton (Kette K1).
 *
 * **Akku:** im Hintergrund (Seite unsichtbar) und ohne native Kachel wird der
 * Kontext GESCHLOSSEN, nicht angehalten — ein angehaltener hielte die
 * Audio-Einheit von WebKit weiter.
 */

/** Gleichspannung weit unter jeder Hörbarkeit — Begründung oben. */
export const STUMMER_PEGEL = 1e-8;

/** Was die Klasse vom AudioContext braucht — ein Test baut es nach. */
export interface KontextArt {
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createConstantSource(): {
    offset: { value: number };
    connect(ziel: unknown): unknown;
    start(): void;
  };
}

export class StummerKontext {
  readonly #neu: () => KontextArt | null;
  #ctx: KontextArt | null = null;
  #gewollt = false;
  #sichtbar = true;
  #bereit: Promise<boolean> = Promise.resolve(false);

  constructor(neu: () => KontextArt | null) {
    this.#neu = neu;
  }

  get laeuft(): boolean {
    return this.#ctx !== null;
  }

  /** `gewollt`: eine native Kachel spielt; `sichtbar`: die Seite ist vorn. */
  setzen(e: { gewollt?: boolean; sichtbar?: boolean }): void {
    if (e.gewollt !== undefined) this.#gewollt = e.gewollt;
    if (e.sichtbar !== undefined) this.#sichtbar = e.sichtbar;
    const soll = this.#gewollt && this.#sichtbar;
    if (soll && !this.#ctx) this.#starten();
    else if (!soll && this.#ctx) {
      void this.#ctx.close().catch(() => undefined);
      this.#ctx = null;
      this.#bereit = Promise.resolve(false);
    }
  }

  /** Läuft der Kontext (oder gleich)? `false`, wenn es keinen gibt. */
  bereit(): Promise<boolean> {
    return this.#bereit;
  }

  #starten(): void {
    let ctx: KontextArt | null = null;
    try {
      ctx = this.#neu();
      if (!ctx) return;
      const quelle = ctx.createConstantSource();
      quelle.offset.value = STUMMER_PEGEL;
      quelle.connect(ctx.destination);
      quelle.start();
    } catch {
      void ctx?.close().catch(() => undefined);
      return;
    }
    this.#ctx = ctx;
    const eigen = ctx;
    this.#bereit = eigen.resume().then(
      () => this.#ctx === eigen && eigen.state === 'running',
      () => false
    );
  }
}
