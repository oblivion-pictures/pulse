/**
 * Ein Anlass, nach der Mitteilungs-Erlaubnis zu fragen, der nicht aus dem
 * Composer kommt — angenommene Freundschaftsanfrage, erste eingehende
 * Direktnachricht bei offener App (Eigentümer-Entscheid 2026-10-18).
 *
 * Die Sendung im Composer zählt `MessageInput` selbst
 * (`sendungGezaehlt` + `mitteilungenAnfragen`); diese Datei ist das Gegenstück
 * für die Anlässe, die das Gateway meldet. Sie merkt den Anlass und stösst
 * dieselbe Frage an — mit Vorerklärung, nur auf iOS, und billig bei
 * wiederholtem Aufruf: liegt die Erlaubnis vor oder ist sie verweigert, kehrt
 * `mitteilungenAnfragen` vor jeder Frage zurück, und ein „später" sperrt die
 * Vorerklärung für `SPAETER_GILT_MS` (s. `berechtigungRegel.ts`). Dass sie bei
 * jeder eingehenden DM gerufen wird, fragt also nicht öfter, sondern bei der
 * ersten, die ankommt, solange noch nichts entschieden ist.
 *
 * Android fragt beim Start und bekommt hier nichts (`mitteilungenAnfragen` ist
 * dort ein Nichts, Eigentümer-Entscheid 2026-10-16).
 */
import { anlassMerken } from './berechtigung.svelte';
import { mitteilungenAnfragen } from './fcm';

export function mitteilungsAnlassMelden(): void {
  anlassMerken();
  void mitteilungenAnfragen();
}
