/**
 * Was ein Tipp auf eine Push-Meldung auslöst — der Hörer zu
 * `notificationActionPerformed` (`fcm.ts`). Wohin er führt, regelt
 * `mitteilungsZiel.ts`; hier stehen nur die Stores, die dazu gehören.
 *
 * Aus `fcm.ts` herausgelöst (2026-10-20, Grössen-Policy).
 */
import { vonAussenOeffnen } from '$lib/navigation/navigationsHerkunft';
import { drafts } from '$lib/stores/drafts.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { bannerAntworten } from './bannerAntwort.svelte';
import { mitteilungsZiel } from './mitteilungsZiel';

/**
 * Push-Tap → Deep-Link in den Chat (DM und private Gruppe unter `/app/@me`,
 * ein Gilden-Kanal auf seiner Kanal-Route — `mitteilungsZiel.ts`).
 *
 * Die Aktion „Antworten" bringt den im Banner getippten Text mit. Er wird
 * nicht HIER gesendet — Senden heisst bei einer verschlüsselten DM, eine
 * Sitzung aufzubauen und den Umschlag zu bauen, und das gehört in den Chat,
 * der gerade aufgeht. Dort wird er gesendet, sobald die Seite den Kanal kennt
 * (`bannerAntwort.svelte.ts`, Bughunt 2026-10-11, T10: bis dahin landete er
 * nur als Entwurf, obwohl der Knopf „Senden" heisst).
 */
export function zeigAn(event: {
  notification: { data?: unknown };
  actionId?: string;
  inputValue?: string;
}): void {
  // Ziel nach Kanalart (iOS-Bughunt 2, C4) — Regel in `mitteilungsZiel.ts`.
  const ziel = mitteilungsZiel(event.notification?.data, gildeVonKanal);
  if (!ziel) return;
  const text = event.actionId === 'antworten' ? (event.inputValue ?? '').trim() : '';
  if (text && ziel.kanalId) {
    // Gesendet wird nur auf der DM-Seite; in einem Gilden-Kanal wartet die
    // Antwort als Entwurf im Eingabefeld, statt unbemerkt liegen zu bleiben.
    if (ziel.antwortWirdGesendet) bannerAntworten.ablegen(ziel.kanalId, text);
    else drafts.einsetzen(ziel.kanalId, text);
  }
  void vonAussenOeffnen(ziel.pfad);
}

/** In welcher Gilde liegt dieser Kanal? `null`, wenn der Klient es nicht weiss. */
function gildeVonKanal(kanalId: string): string | null {
  for (const [gilde, kanaele] of Object.entries(guilds.channelsByGuild)) {
    if (kanaele.some((k) => k.id === kanalId)) return gilde;
  }
  return null;
}

