/**
 * Attribute für Felder mit technischem Inhalt (Links, Adressen, Namen): die iOS-
 * Tastatur schreibt dort sonst den ersten Buchstaben groß, „korrigiert" und
 * unterringelt. **Nur in der iOS-Hülle** — am Rechner bleibt das Feld
 * unverändert (dort wäre `spellcheck=false` eine sichtbare Änderung). Auf das
 * Feld zu verteilen: `<Input {...technischeEingabe()} />`.
 */
import { isCapacitorIOS } from './runtime';

export function technischeEingabe(): Record<string, string | boolean> {
  return isCapacitorIOS()
    ? { autocapitalize: 'none', autocorrect: 'off', spellcheck: false }
    : {};
}
