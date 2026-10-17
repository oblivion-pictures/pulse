/**
 * Darf der Stream-Ton gerade nativ spielen — und hält er WebKits `ambient`?
 * Eine Stelle für alle Kacheln (Gegenprüfung 2026-10-17, S1 und S8).
 *
 * Der Halter `streamton` (`platform/iosSprache.ts`) stellt WebKit auf
 * `ambient` und `iosTon` still. Das ist nur richtig, solange die WebView
 * selbst nichts braucht, was unter `ambient` nicht geht:
 *
 * - **Eine Aufnahme der WebView** (Mikrofontest, Sprachnachricht, Kamera):
 *   unter `ambient` hätte sie keinen Eingang. Der Halter fällt, die nativen
 *   Kacheln setzen aus (`pause`) und laufen danach wieder an. Der Ton wäre
 *   ohnehin unterbrochen — WebKits Aufnahme ist nicht mischbar.
 * - **Eine eigene Wiedergabe der WebView ausserhalb eines Raums** (S8:
 *   Watch-Party, eine Kachel im Rückfall): unter `ambient` folgte sie dem
 *   Stummschalter und endete beim Sperren. Ohne `ambient` aber nähme ihre nicht
 *   mischbare Session der Hülle die ihre — der native Ton bräche ab. Beides
 *   zugleich gibt es nicht; deshalb wechseln die nativen Kacheln dann
 *   ebenfalls auf den WebView-Ton (`rueckfall`), und alles spielt wie vor dem
 *   nativen Weg. In einem Raum ist WebKit ohnehin `ambient` (Halter des Raums),
 *   dort ändert eine Wiedergabe der WebView nichts.
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`); die Wirkungen werden hineingereicht.
 */

export type Lage = 'nativ' | 'pause' | 'rueckfall';

export interface Eingaben {
  /** Nimmt die WebView gerade auf (`platform/webAufnahme.ts`)? */
  aufnahme: boolean;
  /** Spielt die WebView selbst Ton ab (`iosTon`-Wiedergaben)? */
  webWiedergabe: boolean;
  /** Hält ein nativer Raum (Kanal, Anruf, Vorhalt) WebKit auf `ambient`? */
  raum: boolean;
}

export function lageAus(e: Eingaben): Lage {
  if (e.aufnahme) return 'pause';
  if (e.webWiedergabe && !e.raum) return 'rueckfall';
  return 'nativ';
}

export interface Teilnehmer {
  lageSetzen(l: Lage): void;
}

export class StreamTonLage {
  readonly #halter: (an: boolean) => void;
  readonly #alle = new Set<Teilnehmer>();
  readonly #wollen = new Set<Teilnehmer>();
  #e: Eingaben = { aufnahme: false, webWiedergabe: false, raum: false };
  #gehalten = false;
  #lage: Lage = 'nativ';

  constructor(halter: (an: boolean) => void) {
    this.#halter = halter;
  }

  get lage(): Lage {
    return this.#lage;
  }

  anmelden(t: Teilnehmer): void {
    this.#alle.add(t);
  }

  abmelden(t: Teilnehmer): void {
    this.#alle.delete(t);
    this.#wollen.delete(t);
    this.#anwenden();
  }

  /** Spielt `t` gerade nativ (oder baut auf)? Davon hängt der Halter ab. */
  wollen(t: Teilnehmer, an: boolean): void {
    if (an) this.#wollen.add(t);
    else this.#wollen.delete(t);
    this.#anwenden();
  }

  setzen(e: Partial<Eingaben>): void {
    this.#e = { ...this.#e, ...e };
    this.#anwenden();
  }

  /** **Erst der Halter, dann die Kacheln** — eine beginnende Aufnahme muss
   *  WebKit schon ohne `ambient` vorfinden, ehe `getUserMedia` weiterläuft. */
  #anwenden(): void {
    const lage = lageAus(this.#e);
    const halten = lage === 'nativ' && this.#wollen.size > 0;
    if (halten !== this.#gehalten) {
      this.#gehalten = halten;
      this.#halter(halten);
    }
    if (lage === this.#lage) return;
    this.#lage = lage;
    for (const t of [...this.#alle]) t.lageSetzen(lage);
  }
}
