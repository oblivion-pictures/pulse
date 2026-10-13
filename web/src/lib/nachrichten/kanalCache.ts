/**
 * Die Reihenfolge, in der Kanäle zuletzt benutzt wurden — die Rechnung hinter
 * dem LRU-Deckel des Nachrichten-Stores (`stores/messages.svelte.ts`).
 *
 * Reine Buchhaltung, bewusst ohne `$state`: nichts davon wird angezeigt. Sie
 * hält den Arbeitsspeicher klein, der Store sonst für jeden je besuchten
 * Kanal einer Sitzung Nachrichten vorhielte: über dem Deckel fliegt der am
 * längsten unbenutzte Kanal raus (beim Zurückkommen holt ihn der bestehende
 * `!loadedChannels`-Weg sauber neu). Der Store entscheidet, WANN geräumt wird
 * und wie ein Kanal geleert wird; hier steht nur, WER dran ist.
 *
 * Importfrei (s. CLAUDE.md, `pnpm test:unit`-Falle).
 */
export class ZuletztBenutzt {
  /** Älteste zuerst, der zuletzt benutzte Kanal steht am Ende. */
  private reihenfolge: string[] = [];

  /** Setzt einen Kanal an das „zuletzt benutzt“-Ende. */
  anheben(kanalId: string): void {
    this.entfernen(kanalId);
    this.reihenfolge.push(kanalId);
  }

  entfernen(kanalId: string): void {
    const i = this.reihenfolge.indexOf(kanalId);
    if (i !== -1) this.reihenfolge.splice(i, 1);
  }

  leeren(): void {
    this.reihenfolge = [];
  }

  /** Die Kanäle, die geräumt werden müssen, damit höchstens `max` im Cache
   *  bleiben — in der Reihenfolge, in der sie dran sind. `imCache` sind die
   *  Kanäle, die gerade Nachrichten halten; nur die zählen und kommen in
   *  Frage (ein Kanal der Reihenfolge ohne Nachrichten ist schon leer). Der
   *  zuletzt angehobene Kanal steht am Ende und kommt als letzter dran;
   *  Kanäle, die Nachrichten halten, aber nie angehoben wurden (etwa weil nur
   *  `upsert` sie angelegt hat), zählen gegen den Deckel, stehen aber nicht in
   *  der Reihenfolge und werden nie ausgewählt. */
  zuRaeumen(imCache: string[], max: number): string[] {
    const vorhanden = new Set(imCache);
    const raus: string[] = [];
    let anzahl = vorhanden.size;
    for (const kanalId of this.reihenfolge) {
      if (anzahl <= max) break;
      if (vorhanden.has(kanalId)) {
        raus.push(kanalId);
        anzahl--;
      }
    }
    return raus;
  }
}
