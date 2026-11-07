/**
 * Wohin das `activity`-Lebenszeichen geht — reine Rechnung, importfrei
 * (Node-Unit-Test, `test/aktivitaet-ziele.test.ts`; die Hülle mit den
 * Listenern ist `activity.ts`).
 *
 * An den aktiven Server UND an die Cloud: Den eigenen Status (Punkt am
 * Namen, das, was Freunde sehen) führt die Cloud (`handlers/ready.ts`,
 * Social-Teil). Ging das Lebenszeichen nur an den aktiven Server, hörte die
 * Cloud bei einem aktiven Heimserver nie davon — ihr Sweeper setzte nach
 * 10 min „abwesend", und kein Klicken holte es zurück (Meldung 2026-11-07).
 */

/** Server-IDs, an die ein Lebenszeichen geht; doppelte entfallen. */
export function aktivitaetZiele(
  aktivId: string | null | undefined,
  cloudId: string | null | undefined,
): string[] {
  const ziele: string[] = [];
  if (aktivId) ziele.push(aktivId);
  if (cloudId && cloudId !== aktivId) ziele.push(cloudId);
  return ziele;
}

/** Meldet sich eine Verbindung gleich nach ihrem `ready`? Dieselben Ziele wie
 *  oben (Cloud oder aktiv) und nur bei sichtbarem Fenster — dieselbe Regel wie
 *  das Lebenszeichen selbst. Ohne das blieb nach jedem Neuverbinden
 *  (Standby, Netzwechsel) das „abwesend" aus dem ready stehen, bis die
 *  nächste Mausbewegung die Minuten-Bremse passierte. */
export function meldetSichNachReady(v: {
  istCloud: boolean;
  istAktiv: boolean;
  verborgen: boolean;
}): boolean {
  return !v.verborgen && (v.istCloud || v.istAktiv);
}
