/**
 * Wohin ein Tipp auf eine Push-Mitteilung führt — die reine Regel.
 *
 * **Nach Kanalart, nicht pauschal nach `/app/@me`** (iOS-Bughunt 2, C4). Bis
 * zum 2026-10-11 öffnete jeder Tipp `/app/@me/<kanal>`. Ein Ablage-Kanal ist
 * aber ein Community-Kanal: die DM-Seite fand ihn nicht („DM nicht gefunden"),
 * und eine Antwort aus dem Banner blieb ungesendet liegen, weil nur die
 * DM-Seite sie abholt. Der Server schickt für Ablage-Kanäle seither keinen
 * Push mehr; die Regel hier deckt, was noch in der Mitteilungszentrale liegt,
 * und jeden künftigen Push mit Gilden-Bezug.
 *
 * Die Kanalart kommt aus der Nutzlast (`guild_id`, falls der Server sie
 * mitschickt), sonst aus dem, was der Klient über seine Gilden weiss. Weiss
 * er nichts (kalter Start, Gilden noch nicht geladen), bleibt es beim alten
 * Ziel — für die Pushes, die der Server heute schickt (DM, private Gruppe),
 * ist das das richtige.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */

export interface MitteilungsZiel {
  /** Der Pfad, der geöffnet wird. */
  pfad: string;
  kanalId: string;
  /** Wird die Antwort aus dem Banner auf DIESER Seite gesendet? Nur die
   *  DM-Seite tut das (`bannerAntwort.svelte.ts`); anderswo wird sie zum
   *  Entwurf im Eingabefeld des Kanals. */
  antwortWirdGesendet: boolean;
}

export function mitteilungsZiel(
  daten: unknown,
  gildeVon: (kanalId: string) => string | null
): MitteilungsZiel | null {
  if (typeof daten !== 'object' || daten === null) return null;
  const feld = (name: string): string => {
    const wert = (daten as Record<string, unknown>)[name];
    return typeof wert === 'string' || typeof wert === 'number' ? String(wert) : '';
  };
  const kanalId = feld('channel_id');
  if (!kanalId) return null;
  const gilde = feld('guild_id') || gildeVon(kanalId);
  if (gilde) {
    return {
      pfad: `/app/guilds/${gilde}/channels/${kanalId}`,
      kanalId,
      antwortWirdGesendet: false
    };
  }
  return { pfad: `/app/@me/${kanalId}`, kanalId, antwortWirdGesendet: true };
}
