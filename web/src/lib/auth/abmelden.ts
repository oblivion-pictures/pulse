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

export async function abmelden(): Promise<void> {
  const t = loadTokens();
  if (t) await logout(t.refresh_token).catch(() => {});
  auth.signOut();
  gateway.disconnect();
  void import('$lib/voice/livekit.svelte').then(({ voice }) => voice.disconnect());
  guilds.clear();
  messages.clear();
  await goto('/login', { replaceState: true });
}
