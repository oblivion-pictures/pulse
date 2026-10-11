import { activeServer } from '$lib/stores/active-server.svelte';
import { appSperre } from '$lib/platform/appSperre.svelte';
import { autoConnectIfConfigured } from './autoconnect.svelte';
import { voice } from './livekit.svelte';
import { clearVoiceResume, loadVoiceResume } from './resume';
import { autoConnectNachAbgleich, resumePlan, type StartAbgleich } from './startBeitritt';
import { startTor } from './startTor.svelte';

/**
 * Was die App beim Start von sich aus im Sprachkanal tut, in der einzigen
 * Reihenfolge, die trägt (Regel: `startBeitritt.ts`):
 *
 *  1. **Auf die Entsperrung warten** (F4). Vorher trat ein Kaltstart mit
 *     Auto-Connect dem Kanal mit offenem Mikrofon bei, während Face ID noch
 *     fragte.
 *  2. **Abgleich und Wiederaufnehmen** — die Hülle zuerst fragen, dann
 *     entscheidet der Resume-Eintrag. „Resume gewinnt" gegen den
 *     Auto-Connect: er trägt den echten letzten Zustand.
 *  3. **Auto-Connect**, falls konfiguriert — nicht, wenn der Nutzer in der
 *     Hülle aufgelegt hat oder sie einen Prüfraum hält
 *     (`autoConnectNachAbgleich`, S4).
 *  4. **Das Tor öffnen** (`startTor`) — erst jetzt darf die Kanal-Route
 *     selbst beitreten. Bis zum 2026-10-11 lief sie schon während Schritt 2
 *     los, sah „nicht verbunden" und verdrängte einen überlebenden nativen
 *     Raum (N1).
 *
 * Aus dem App-Layout aufgerufen, sobald Anmeldung und WS-Ready stehen.
 * Feuer und vergessen; jeder Schritt fängt seine Fehler selbst.
 */
export async function startBeitritteAusfuehren(): Promise<void> {
  startTor.schliessen();
  try {
    await appSperre.entsperrt();
    const abgleich = await resumeVoiceIfPending();
    if (autoConnectNachAbgleich(abgleich)) await autoConnectIfConfigured();
  } finally {
    startTor.oeffnen();
  }
}

/**
 * Wiederaufnehmen nach einem Reload (bis 2026-10-11 in `livekit.svelte.ts`,
 * hierher gezogen, weil die Datei ein Vielfaches über der Grössen-Policy
 * liegt): war der User vor einem Reload in einem Voice-Channel,
 * automatisch zurückverbinden — inkl. Mute/Deafen. Quelle ist der
 * sessionStorage-Eintrag aus `resume.ts`.
 *
 * Gibt das Ergebnis des Abgleichs zurück (`null`, wenn er gar nicht lief) —
 * daran entscheidet `startBeitritteAusfuehren`, ob der Auto-Connect noch darf.
 *
 * Sicherheits-/Korrektheits-Gates (`startBeitritt.ts::resumePlan`):
 *  - kein Rejoin, wenn schon (ver)bunden — auch nicht, wenn das ein Tipp
 *    WÄHREND des Abgleichs mit der Hülle wurde;
 *  - nicht, wenn die Hülle den Raum noch hält (übernommen) oder der Nutzer
 *    ihn dort selbst aufgelegt hat (Eintrag verworfen, Bughunt 2, B1);
 *  - nur wenn der gemerkte Server == aktiver Server ist (sonst andere Token-/
 *    Membership-Welt — vermeidet ungewollte Server-Switch-Seiteneffekte);
 *  - schlägt der Connect fehl (Channel gelöscht, Token verweigert), wird der
 *    Resume-Eintrag verworfen, damit es keine Reload-Schleife gibt.
 *
 * Hinweis Autoplay: Nach einem Reload gibt es keine User-Geste → die Wiedergabe
 * fremder Audiospuren kann bis zum ersten Klick blockiert sein (`audioBlocked`
 * + bestehender Unblock-Pfad in der UI). Der eigene Mic-Publish braucht keine
 * Geste, wenn die Berechtigung schon erteilt war.
 */
export async function resumeVoiceIfPending(): Promise<StartAbgleich | null> {
  const r = loadVoiceResume();
  if (voice.connected || voice.connecting) return null;
  // iOS: hält die Hülle den Raum noch, wird er übernommen statt neu
  // betreten — oder verlassen, wenn ihn nichts bestätigt (`nativAbgleich.ts`).
  // Läuft auch OHNE Eintrag: gerade ein Raum ohne ihn darf nicht unsichtbar
  // weiterlaufen (Bughunt 2026-10-11, E5).
  const abgleich = await voice.nativUebernehmen(r);
  const plan = resumePlan({
    abgleich,
    resume: r,
    aktiverServer: activeServer.serverId,
    imKanal: voice.connected || voice.connecting
  });
  if (!plan.beitreten) {
    if (plan.eintragLoeschen) clearVoiceResume();
    return abgleich;
  }
  try {
    await voice.connect(plan.kanalId, plan.kanalName, plan.optionen);
  } catch {
    // Channel weg / Token verweigert → stale Resume entfernen (keine Schleife).
    clearVoiceResume();
  }
  return abgleich;
}
