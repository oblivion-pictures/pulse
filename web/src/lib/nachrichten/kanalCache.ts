/**
 * Die Reihenfolge, in der Kanäle zuletzt benutzt wurden — die Rechnung hinter
 * dem LRU-Deckel des Nachrichten-Stores (`stores/messages.svelte.ts`).
 *
 * Reine Buchhaltung, bewusst ohne `$state`: nichts davon wird angezeigt. Sie
 * hält den Arbeitsspeicher klein, der Store sonst für jeden je besuchten
 * Kanal einer Sitzung Nachrichten vorhielte: über dem Deckel fliegt zuerst, was
 * nie geöffnet wurde, dann der am längsten unbenutzte Kanal raus — nie der
 * zuletzt geöffnete (beim Zurückkommen holt den Rausgeflogenen der bestehende
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
   *  Frage (ein Kanal der Reihenfolge ohne Nachrichten ist schon leer).
   *
   *  Dran sind zuerst die Kanäle, die Nachrichten halten, aber nie angehoben
   *  wurden — etwa, weil nur `upsert` sie angelegt hat (Postfach-Abholung für
   *  eine ungeöffnete verschlüsselte Unterhaltung): niemand hat sie geöffnet,
   *  und das erste Öffnen ersetzt ihren Inhalt durch einen frischen Ladevorgang
   *  (`setInitial`). Sie zählen gegen den Deckel; stünden sie nicht in der
   *  Reihenfolge und kämen nie dran, räumte der Deckel ab 15 davon den Kanal
   *  weg, den der Nutzer gerade geöffnet hat. Danach die angehobenen, der
   *  am längsten unbenutzte zuerst.
   *
   *  **Der zuletzt angehobene Kanal kommt nie dran.** Er steht am Ende der
   *  Reihenfolge und ist der, den der Nutzer vor sich hat. Ihn zu räumen
   *  leerte die Anzeige, und der Nachlade-Wächter der Seite (er hängt an
   *  `loadedChannels`) holte ihn sofort neu, wonach `setInitial` ihn wieder
   *  räumte — in einer Schleife (nachgemessen: über 100 Abrufe je Sekunde). */
  zuRaeumen(imCache: string[], max: number): string[] {
    const vorhanden = new Set(imCache);
    const gelistet = new Set(this.reihenfolge);
    const kandidaten = [
      ...imCache.filter((kanalId) => !gelistet.has(kanalId)),
      ...this.reihenfolge.slice(0, -1)
    ];
    const raus: string[] = [];
    let anzahl = vorhanden.size;
    for (const kanalId of kandidaten) {
      if (anzahl <= max) break;
      if (vorhanden.has(kanalId)) {
        raus.push(kanalId);
        anzahl--;
      }
    }
    return raus;
  }
}

/** `obj` ohne den Schlüssel `key` (Kopie) — der Store streicht damit einen
 *  Kanal aus seinen Pro-Kanal-Tabellen. */
export function ohne<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _weg, ...rest } = obj;
  return rest;
}
