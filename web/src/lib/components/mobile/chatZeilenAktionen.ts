/**
 * Die Aktionen einer Zeile in der Chats-Liste (⋯-Knopf am Handy). Bewusst nur,
 * was es als Funktion schon gibt: „Als gelesen markieren" (`readState.markRead`,
 * zieht den Lesestand auch zum Server). Stummschalten oder Ausblenden einzelner
 * Gespräche gibt es noch nicht — der Knopf bekommt sie, sobald sie existieren.
 * Ist nichts ungelesen, bleibt die Liste leer und die Zeile ohne Knopf.
 */
import CheckCheckIcon from '@lucide/svelte/icons/check-check';
import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
import { readState } from '$lib/stores/readState.svelte';
import { m } from '$lib/paraglide/messages.js';

export function chatZeilenAktionen(kanalId: string): ZeilenAktion[] {
  if (!readState.isUnread(kanalId)) return [];
  return [
    {
      id: 'als-gelesen',
      label: m.chats_zeile_als_gelesen(),
      icon: CheckCheckIcon,
      onSelect: () => readState.markRead(kanalId),
      testid: `chat-menu-gelesen-${kanalId}`
    }
  ];
}
