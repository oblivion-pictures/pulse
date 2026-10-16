/**
 * Welches Gerät meint eine Steuer-Anfrage am Personen-Knopf? — als reine Regel.
 *
 * Eine Anfrage an einen Host mit Gerät im Kanal ging bis zum Prüfbefund vom
 * 2026-10-16 IMMER an das (erste) Gerät dieses Kontos im Kanal — auch wenn der
 * Knopf am eigenen Go-Live-Strom des Besitzers hing. Der Server behandelte sie
 * dann als Geräte-Anfrage (Freigabeliste statt Zustimmungsdialog), und die
 * gewohnte Fernsteuerung einer Person war verbogen.
 *
 * Deshalb: ein Gerät nur, wenn der angefragte Platz in seinen `stream_slots`
 * steht — dann ist der Strom wirklich seiner. Sonst `null` = ein Mensch, die
 * Anfrage bleibt die gewohnte. Die Geräteansicht nennt ihr Gerät ausdrücklich
 * (`schirme.svelte.ts`) und braucht diese Regel nicht.
 *
 * Importfrei, damit Nodes Testläufer es prüfen kann (`pnpm test:unit`-Falle).
 */

export interface GeraetPlaetze {
  id: string;
  /** Plätze, auf denen das Gerät gerade sendet (`Device.stream_slots`). */
  stream_slots?: readonly number[];
}

/** Das Gerät, das auf `slot` sendet, unter den Geräten des Hosts im Kanal. */
export function geraetFuerPlatz(geraete: readonly GeraetPlaetze[], slot: number): string | null {
  return geraete.find((d) => (d.stream_slots ?? []).includes(slot))?.id ?? null;
}
