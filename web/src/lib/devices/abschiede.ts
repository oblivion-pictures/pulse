/**
 * Plätze, die das Gerät gerade auf Wunsch des Steuernden schließt — ihre
 * Eingaben werden kurz verworfen statt als Fehler gewertet (Regel und
 * Begründung: `$lib/remote/schirmZuRegel.ts`). Eigenes Modul, weil drei Stellen
 * dieselbe Liste brauchen (`schirmZu.ts`, `wecken.ts`, `ws/handlers/remote.ts`)
 * und `wecken.ts` sonst einen Ring mit `schirmZu.ts` bildete.
 */
import { Abschiede } from '$lib/remote/schirmZuRegel';

export const schirmAbschiede = new Abschiede();
