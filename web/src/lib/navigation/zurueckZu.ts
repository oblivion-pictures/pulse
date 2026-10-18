import { goto } from '$app/navigation';
import { markiereZurueck } from './richtung';

/**
 * Ein Zurück-Pfeil: navigiert zur Elternseite und merkt vorher, dass es ein
 * Zurück ist, damit die Elternseite von links hereingleitet statt von rechts
 * (`navigation/richtung.ts`).
 */
export function zurueckZu(pfad: string): Promise<void> {
  markiereZurueck('zurueck');
  return goto(pfad);
}
