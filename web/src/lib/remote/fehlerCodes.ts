/**
 * Welche Fehler-Rahmen (`{op:'error', code}`) zu welchem Vorgang gehören —
 * als reine Regel, ohne Texte.
 *
 * Die Rahmen tragen keine Sitzungs- oder Gerätekennung, nur den Code. Wer auf
 * sie wartet, muss deshalb am Code erkennen, ob er gemeint ist — und darf
 * keinen fremden Fehler (fehlgeschlagener Chat-Send, Rate-Limit) für seinen
 * halten. Die Texte dazu stehen in `fehlertexte.ts` (Paraglide, darum nicht
 * hier: diese Datei bleibt importfrei für Nodes Testläufer — `pnpm
 * test:unit`-Falle).
 *
 * Gegenstücke im Gateway: `ws_remote_handlers.py` (4050–4056),
 * `ws_remote_geraet.py::NICHT_FREIGEGEBEN_CODE` (4062 bei einer Anfrage an ein
 * Gerät), `ws_device_handlers.py::handle_wake` (4056, 4060–4062 beim Wecken).
 */

import { WS_FEHLER } from '../api/constants.ts';

/**
 * Gehört der Code zu einer Fernsteuer-Anfrage oder -Antwort?
 *
 * 4050–4059 wie bisher; dazu seit 2026-10-16 4062 — eine Anfrage an einen
 * Remote-Rechner, für den der Anfragende nicht freigegeben ist. Ohne diesen
 * Code wartete der Steuernde bis in die Frist, statt den Grund zu lesen.
 * Grenze: der Rahmen trägt keine Kennung, ein 4062 auf einen gleichzeitigen
 * Weckruf an ein anderes Gerät bräche eine laufende Anfrage mit ab — die
 * Geräteansicht schickt die Anfrage aber erst nach dem Bild, also nach dem
 * Weckruf, und nur mit Freigabe.
 */
export function istAnfrageFehler(code: number): boolean {
  return (code >= 4050 && code <= 4059) || code === WS_FEHLER.GERAET_NICHT_FREIGEGEBEN;
}

export type WeckFehler = 'nicht_freigegeben' | 'offline' | 'zu_schnell';

/**
 * Wie lange nach einem Weckruf ein Fehler-Rahmen ihm noch zugeordnet wird.
 * Der Gateway lehnt sofort ab (eine Datenbankabfrage); was später kommt —
 * etwa die 4056 einer Personen-Anfrage —, gehört nicht mehr zum Weckruf.
 */
export const WECKFEHLER_FENSTER_MS = 5_000;

/**
 * Warum ein Weckruf abgelehnt wurde — `null`, wenn der Code nicht zum Wecken
 * gehört.
 *
 * **4060 heisst für die Anzeige „nicht freigegeben"**, obwohl der Server
 * damit „gibt es nicht" meint: er antwortet so auch, wenn der Rufer den
 * Standplatz nicht sieht, um nichts über versteckte Kanäle zu verraten. Wer
 * die Geräteansicht offen hat, kennt das Gerät aber — ihm „gibt es nicht" zu
 * sagen, wäre falscher als „nicht für dich freigegeben".
 */
export function weckFehlerArt(code: number): WeckFehler | null {
  if (code === WS_FEHLER.GERAET_UNBEKANNT || code === WS_FEHLER.GERAET_NICHT_FREIGEGEBEN) {
    return 'nicht_freigegeben';
  }
  if (code === WS_FEHLER.GERAET_OFFLINE) return 'offline';
  // Dieselbe Zwei-Sekunden-Bremse wie bei der Anfrage (`fehlertexte.ts`).
  if (code === 4056) return 'zu_schnell';
  return null;
}
