/**
 * Der lokale Schalter „Steuern erlauben" am Remote-Rechner — als reine Regel.
 *
 * **Seit 2026-10-16 ein Notaus** (Eigentümer-Entscheid 2): WER einen Rechner
 * wecken und steuern darf, entscheidet allein der Server über die
 * Freigabeliste (`geraete_freigabe.py`). Der Schalter am Gerät kann das nur
 * noch verbieten, nie erlauben: steht er auf aus — oder ist seine alte, befristete
 * Fassung abgelaufen —, weckt sich der Rechner nicht (`devices/wecken.ts`) und
 * stimmt keiner Anfrage zu (`geraeteanbindung.ts`). Der Server kennt den
 * Schalter nicht.
 *
 * Importfrei, damit Nodes Testläufer es prüfen kann (`pnpm test:unit`-Falle:
 * keine Runen, keine erweiterungslosen Importe) — die Rune-Hülle
 * `standplatz.svelte.ts` reicht ihren Stand nur herein.
 */

export interface NotausStand {
  /** Ist der gespeicherte Stand schon gelesen? Bis dahin: aus. */
  geladen: boolean;
  aktiv: boolean;
  /** Ende einer alten, befristeten Freigabe (ms seit Epoche), `null` = ohne. */
  gueltigBis: number | null;
}

/** Darf dieser Rechner gerade geweckt und gesteuert werden? Fail-closed an
 *  jeder Abzweigung. */
export function steuernErlaubt(stand: NotausStand, jetzt: number): boolean {
  if (!stand.geladen || !stand.aktiv) return false;
  return stand.gueltigBis === null || stand.gueltigBis > jetzt;
}
