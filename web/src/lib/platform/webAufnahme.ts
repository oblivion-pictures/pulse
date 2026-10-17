/**
 * Nimmt die WebView gerade auf? — für den nativen Stream-Ton der iOS-Hülle.
 *
 * **Warum es das braucht** (Gegenprüfung 2026-10-17, S1). Solange eine Kachel
 * nativ spielt, erklärt sich WebKit `ambient` (Halter `streamton`), und WebKit
 * nimmt diese Übersteuerung VOR seiner Aufnahme-Regel
 * (`MediaSessionManagerCocoa.mm`): ein `getUserMedia` liefe in einer Kategorie
 * ohne Eingang. Mikrofontest, Sprachnachricht und Kamera-Aufnahme nähmen still
 * nichts auf. Für die Dauer jeder Aufnahme muss der Halter also fallen.
 *
 * **Warum an `getUserMedia` selbst und nicht an den Aufrufern.** Es gibt fünf
 * Aufrufstellen (Mikrofontest, Sprachnachricht, Kamera-Blatt, eigenes Signal,
 * LiveKits Web-Weg) und künftig mehr; eine vergessene wäre genau der stille
 * Fehler. Gehüllt wird einmal, nur in der iOS-Hülle mit nativem Stream-Ton.
 *
 * **Der Ruf meldet sich VOR dem eigentlichen `getUserMedia`** — WebKit wählt
 * die Kategorie beim Beginn der Aufnahme, der Halter muss bis dahin gefallen
 * sein. Zu Ende ist die Aufnahme, wenn keine ihrer Tonspuren mehr lebt.
 * `track.stop()` feuert kein `ended`-Ereignis (Media Capture spec), deshalb
 * wird der Zustand der Spuren abgefragt, solange es welche gibt.
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`); die Geräte-Schnittstelle wird
 * hineingereicht.
 */

type Spur = { kind: string; readyState: string };
type Strom = { getTracks(): Spur[] };
export interface Geraete {
  getUserMedia(c?: unknown): Promise<Strom>;
}

const TAKT_MS = 1000;

export class WebAufnahme {
  #offen = 0;
  readonly #spuren = new Set<Spur>();
  #aktiv = false;
  #uhr: ReturnType<typeof setInterval> | undefined;
  readonly #melden: (aktiv: boolean) => void;

  constructor(melden: (aktiv: boolean) => void) {
    this.#melden = melden;
  }

  get aktiv(): boolean {
    return this.#aktiv;
  }

  /** `geraete.getUserMedia` umhüllen. Nur Rufe MIT Ton zählen. */
  einhaengen(geraete: Geraete): void {
    const original = geraete.getUserMedia.bind(geraete);
    geraete.getUserMedia = async (c?: unknown) => {
      const mitTon = !!(c as { audio?: unknown } | undefined)?.audio;
      if (!mitTon) return original(c);
      this.#offen += 1;
      this.#neu();
      try {
        const strom = await original(c);
        for (const s of strom.getTracks()) if (s.kind === 'audio') this.#spuren.add(s);
        return strom;
      } finally {
        this.#offen -= 1;
        this.pruefen();
      }
    };
  }

  /** Beendete Spuren austragen (auch aus dem Takt). */
  pruefen(): void {
    for (const s of this.#spuren) if (s.readyState === 'ended') this.#spuren.delete(s);
    this.#neu();
  }

  #neu(): void {
    const aktiv = this.#offen > 0 || this.#spuren.size > 0;
    if (this.#spuren.size > 0 && !this.#uhr) {
      this.#uhr = setInterval(() => this.pruefen(), TAKT_MS);
    } else if (this.#spuren.size === 0 && this.#uhr) {
      clearInterval(this.#uhr);
      this.#uhr = undefined;
    }
    if (aktiv === this.#aktiv) return;
    this.#aktiv = aktiv;
    this.#melden(aktiv);
  }
}
