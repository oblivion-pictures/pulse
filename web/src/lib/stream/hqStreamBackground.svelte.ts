/**
 * Anchor registry for HQ stream tiles — thin wrapper around the shared
 * `createAnchorRegistry` (user snowflake key, no "open" set: that already
 * lives in `openedTiles`).
 *
 * `StreamGrid` registers an anchor per open HQ tile; `HqStreamBackgroundHost`
 * in the app layout overlays the `WhepPlayer` on it (docked) or renders it
 * as a corner window when no anchor exists (you navigated to a text channel
 * or DM).
 *
 * Dritter Fall seit 2026-10-19: der Stream läuft im eigenen Player-Fenster
 * (`imFenster`). Dann gibt es weder Anker noch Eckfenster — der `WhepPlayer`
 * bleibt im Host unsichtbar gemountet, weil ER die Fenster-Sitzung hält
 * (`useNativePlayback`); ausgehängt ginge das Fenster mit ihm zu.
 */

import { createAnchorRegistry } from './anchorRegistry.svelte';
import { parseHqTileId } from './hqTile';
import { nativePlayerSessions } from '$lib/player/store.svelte';
import { laeuftImFenster } from '$lib/player/imFenster';

const registry = createAnchorRegistry();

export const hqStreamBackground = {
  registerAnchor(channelId: string, userId: string, el: HTMLElement): () => void {
    return registry.register(`${channelId}::${userId}`, el);
  },
  anchorRect(channelId: string, userId: string): DOMRect | null {
    return registry.rect(`${channelId}::${userId}`);
  },
  /** Ersetzt das Player-Fenster diese Kachel (`tileId` = `<userId>:<slot>`)?
   *  Reaktiv über die Sitzungs-Registry; Schwelle s. `laeuftImFenster`. */
  imFenster(channelId: string, tileId: string): boolean {
    const { userId, slot } = parseHqTileId(tileId);
    return laeuftImFenster(nativePlayerSessions.get(channelId, userId, slot));
  }
};
