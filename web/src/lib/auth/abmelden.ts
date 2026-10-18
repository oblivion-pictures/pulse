/**
 * Das vollständige Abmelden — EINE Fassung für den Fußbereich (`UserFooter`)
 * und die Sperrfläche der App-Sperre (`AppSperre`): erst den Server-Widerruf
 * des Refresh-Tokens (best effort), dann die lokale Sitzung, die Verbindungen
 * und die Speicher räumen, zuletzt zur Anmeldung. Wer nur `auth.signOut()`
 * rief, ließ Gateway-Verbindung, Voice und Gemeinschafts-/Nachrichten-Speicher
 * stehen und den Refresh-Token am Server gültig.
 */
import { goto } from '$app/navigation';
import { logout } from '$lib/api/auth';
import { loadTokens } from '$lib/api/storage';
import { auth } from '$lib/stores/auth.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { gateway } from '$lib/ws/connection';

/** Wie lange der Server-Widerruf warten darf, bevor lokal trotzdem abgemeldet wird. */
const WIDERRUF_FRIST_MS = 5000;

let laeuft = false;

export async function abmelden(): Promise<void> {
  // Ein zweiter Tipp während der Abmeldung darf sie nicht noch einmal anstoßen.
  if (laeuft) return;
  laeuft = true;
  try {
    await abmeldenEinmal();
  } finally {
    laeuft = false;
  }
}

async function abmeldenEinmal(): Promise<void> {
  const t = loadTokens();
  if (t) {
    // Ohne Netz hinge der Widerruf bis zum Zeitlimit der Anfrage; die Sitzung
    // muss trotzdem enden (der Token läuft am Server von selbst ab).
    let frist: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      logout(t.refresh_token).catch(() => {}),
      new Promise<void>((weiter) => {
        frist = setTimeout(weiter, WIDERRUF_FRIST_MS);
      })
    ]);
    clearTimeout(frist);
  }
  auth.signOut();
  gateway.disconnect();
  void import('$lib/voice/livekit.svelte').then(({ voice }) => voice.disconnect());
  guilds.clear();
  messages.clear();
  await goto('/login', { replaceState: true });
}
