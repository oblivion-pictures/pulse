/**
 * Ein gescheitertes `subscribe` wird wiederholt.
 *
 * Der Klient trägt einen Kanal in `subs` ein, sobald er das Abo schickt; ob
 * der Server es angenommen hat, sagt nur ein Fehlerrahmen. Bis 2026-10-21
 * verwarf der Klient jeden Fehlerrahmen (`handlers/error.ts`) — der Kanal
 * galt als abonniert, war es am Server aber nicht, und bis zum nächsten
 * Neuaufbau kam keine Live-Nachricht mehr. Seither nennt der Rahmen Op und
 * Kanal (`ref_op`, `channel_id`; `routes/ws_abo_fehler.py`), und hier steht,
 * wann und wie oft neu abonniert wird.
 *
 * Ablauf je Kanal: Fehler → nach der Stufe `erneut(kanal, versuch)` — der
 * Aufrufer schickt das Abo und dahinter eine Pong-Schranke
 * (`pongSchranke.ts`). Kommt der Pong, ohne dass vorher ein neuer Fehler zu
 * diesem Versuch eintraf, ist das Abo durch (`bestaetigt` → `true`), und der
 * Aufrufer holt nach, was in der Lücke lag. Der Server arbeitet die Rahmen
 * eines Sockets der Reihe nach ab, der Fehler zum Abo käme also VOR dem Pong.
 *
 * Importfrei bis auf die Stufen (Test: `nachhol-netz`).
 */
import { ABO_WIEDERHOLBARE_FEHLER, naechsteWartezeit, type Planer } from './nachholTakt.ts';

export class AboWiederholung {
  readonly #planer: Planer;
  readonly #erneut: (kanalId: string, versuch: number) => void;
  /** Kanal → Zahl der Fehlschläge in Folge und die geplante Runde. */
  readonly #stand = new Map<string, { versuch: number; griff: unknown }>();

  constructor(planer: Planer, erneut: (kanalId: string, versuch: number) => void) {
    this.#planer = planer;
    this.#erneut = erneut;
  }

  /** Ein Abo-Fehlerrahmen für `kanalId` kam an. */
  fehler(kanalId: string, code: number): void {
    const vorher = this.#stand.get(kanalId);
    if (!ABO_WIEDERHOLBARE_FEHLER.has(code)) {
      this.vergessen(kanalId);
      return;
    }
    if (vorher?.griff) return; // eine Runde ist schon geplant
    const versuch = (vorher?.versuch ?? 0) + 1;
    const warte = naechsteWartezeit(versuch);
    if (warte === null) {
      this.#stand.delete(kanalId);
      return;
    }
    const eintrag: { versuch: number; griff: unknown } = { versuch, griff: null };
    eintrag.griff = this.#planer.planen(() => {
      eintrag.griff = null;
      this.#erneut(kanalId, versuch);
    }, warte);
    this.#stand.set(kanalId, eintrag);
  }

  /** Die Pong-Schranke hinter Versuch `versuch` ist durch. `true` = das Abo
   *  hat gehalten, jetzt nachholen; danach ist der Kanal vergessen. */
  bestaetigt(kanalId: string, versuch: number): boolean {
    const eintrag = this.#stand.get(kanalId);
    if (!eintrag || eintrag.versuch !== versuch || eintrag.griff) return false;
    this.#stand.delete(kanalId);
    return true;
  }

  /** Kanal abbestellt — eine geplante Runde fällt weg. */
  vergessen(kanalId: string): void {
    const eintrag = this.#stand.get(kanalId);
    if (eintrag?.griff) this.#planer.abbrechen(eintrag.griff);
    this.#stand.delete(kanalId);
  }

  /** Socket weg: der Nachfolger abonniert ohnehin alle Kanäle neu. */
  alleVergessen(): void {
    for (const kanalId of [...this.#stand.keys()]) this.vergessen(kanalId);
  }
}
