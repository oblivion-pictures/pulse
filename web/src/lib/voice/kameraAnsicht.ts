/**
 * Wann sich die native Kanalansicht (iOS) von selbst öffnet — die reine
 * Rechnung neben `nativerRaum.svelte.ts`. **Importfrei** (Pflicht für
 * `pnpm test:unit`, s. CLAUDE.md).
 *
 * **Eigentümer-Entscheid 2026-10-17 (Variante a):** ein Beitritt allein öffnet
 * die Ansicht nicht mehr. Sie zeigt Kamerabilder, und ohne Kamera zeigte sie
 * nur, was die Kachelansicht im Web auch zeigt — sie lag dann bloss im Weg.
 * Von selbst öffnet sie sich, wenn im Kanal eine Kamera (fremde oder eigene)
 * angeht, und beim Beitritt, wenn schon eine läuft.
 *
 * **Einmal je Kamera-Start.** Wischt der Nutzer die Ansicht weg, solange
 * dieselbe Kamera läuft, bleibt sie zu — sonst holte sie jede neue
 * Teilnehmerliste (Sprechen, Stummschalten, jemand kommt) zurück. Deshalb
 * merkt sich der Aufrufer, welche Kameras er schon gesehen hat; eine Kamera,
 * die ausgeht, fällt aus der Menge, und ihr nächster Start zählt wieder.
 */

export interface KameraTraeger {
  identity: string;
  cameraOn: boolean;
}

export interface KameraAbgleich {
  /** Die Kameras, die jetzt laufen — die Menge für den nächsten Abgleich. */
  gesehen: Set<string>;
  /** Ist seit dem letzten Abgleich eine Kamera NEU angegangen? */
  neu: boolean;
}

export function kamerasAbgleichen(
  gesehen: ReadonlySet<string>,
  liste: readonly KameraTraeger[]
): KameraAbgleich {
  const laufend = new Set(liste.filter((t) => t.cameraOn).map((t) => t.identity));
  const neu = [...laufend].some((id) => !gesehen.has(id));
  return { gesehen: laufend, neu };
}
