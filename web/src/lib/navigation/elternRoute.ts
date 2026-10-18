/**
 * Pfad → übergeordnete Route der mobilen Bildschirm-Hierarchie. Die EINE
 * Tabelle für die Android-Zurück-Taste (`platform/zurueckTaste.ts`) und die
 * Kanten-Wischgeste der iOS-Hülle (`platform/zurueckWischen.ts`): beide gehen
 * denselben Weg wie die Zurück-Pfeile der UI.
 *
 * Importfrei (Pflicht für `pnpm test:unit`, s. `tabs.ts`).
 */

/** Pfad → übergeordnete Route. Erster Treffer gewinnt. */
const ELTERN: { test: RegExp; ziel: (m: RegExpMatchArray) => string }[] = [
  // Kanal-Bildschirm (Chat wie Voice) → Kanalliste des Raums — dasselbe Ziel
  // wie der Zurück-Pfeil in ChatView/VoiceChannelView.
  {
    test: /^\/app\/guilds\/([^/]+)\/channels\/[^/]+$/,
    ziel: (m) => `/app/rooms/${m[1]}`
  },
  // Raum-Ansicht → Räume-Übersicht.
  { test: /^\/app\/rooms\/[^/]+$/, ziel: () => '/app/rooms' },
  // Entdecken ist der Ausgang aus der Räume-Leere → zurück in die Räume.
  { test: /^\/app\/discover$/, ziel: () => '/app/rooms' },
  // DM-Chat → Chats-Liste.
  { test: /^\/app\/@me\/[^/]+$/, ziel: () => '/app/@me' },
  // Einstellungs-Unterseite → Du-Bereich. Fehlte, und ohne Regel fiel die
  // Taste dort auf `history.back()` durch: was davor kam, entschied dann der
  // Zufall statt der Bildschirm-Aufbau.
  { test: /^\/app\/me\/[^/]+$/, ziel: () => '/app/me' }
];

/** Die übergeordnete Route zu `pfad`, oder `null` (Wurzel / unbekannt). */
export function elterVon(pfad: string): string | null {
  for (const regel of ELTERN) {
    const m = pfad.match(regel.test);
    if (m) return regel.ziel(m);
  }
  return null;
}
