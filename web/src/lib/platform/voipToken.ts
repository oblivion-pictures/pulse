/**
 * PushKit-Token anmelden (iOS-Liste Punkt 40).
 *
 * **Das ist NICHT der FCM-Token.** Dasselbe Gerät führt beide gleichzeitig:
 * den FCM-Token für Nachrichten-Banner, den PushKit-Token fürs Klingeln.
 * Eigene Tabelle am Server, eigener Endpunkt, eigener APNs-Topic — ein Push,
 * der das Telefon zum Klingeln bringt, ist eine andere Zustellart und keine
 * andere Nutzlast.
 *
 * **Warum ein Hörer und nicht nur ein Abruf.** Der Token kommt vom System,
 * wenn es ihn für richtig hält — meist kurz nach dem Start, aber nicht
 * garantiert, und er kann sich im Betrieb ändern. Der Abruf beim Start deckt
 * den Normalfall, der Hörer den Rest; nativ wird die Meldung aufbewahrt
 * (`retainUntilConsumed`), falls sie vor der WebView da war.
 *
 * **Gemeldet wird erneut, sobald sich Token, Anmelde-Kette oder die
 * Fähigkeiten der Hülle ändern** — nach dem Start, auf den Hörer hin, bei
 * jeder Rückkehr in den Vordergrund und nach einem Passwortwechsel
 * (`voipMeldung.ts`, Nachprüfung der Fix-Runden S2/S3).
 *
 * Alles andere als iOS: No-op.
 */
import { anrufNativ } from './anrufNativ';
import { currentAccessToken, request } from '$lib/api/client';
import { jwtPayload } from '$lib/api/storage';
import { serversStore } from '$lib/api/servers.svelte';
import { pushGeraetId } from './geraeteKennungPush';
import { isCapacitorIOS } from './runtime';
import {
  faehigkeitenAusHuelle,
  ketteAusZugriff,
  meldungNoetig,
  type VoipMeldung
} from './voipMeldung';

/**
 * **An die CLOUD, nicht an den aktiven Server** (Bughunt 2026-10-11, T2).
 * Anrufe gibt es nur in der Cloud (`api/anrufe.ts`), also klingelt nur sie.
 * Bis dahin ging die Meldung an den aktiven Server: mit einem Self-Host davor
 * kannte die Cloud den Token nie, und bei geschlossener App klingelte nichts —
 * und das `DELETE` beim Abmelden traf den Self-Host, die Zeile in der Cloud
 * blieb, und das abgemeldete Telefon klingelte weiter für das alte Konto.
 */
function cloud(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

let gemeldet: VoipMeldung | null = null;
let verfolgt = false;

/** Was die Hülle liefert — `voipToken()` und das `voipToken`-Ereignis. Eine
 *  ältere Hülle schickt keine `faehigkeiten`. */
interface HuellenToken {
  token: string | null;
  faehigkeiten?: unknown;
}

async function melden({ token, faehigkeiten }: HuellenToken): Promise<void> {
  if (!token) return;
  const zugriff = currentAccessToken();
  const neu: VoipMeldung = {
    token,
    kette: ketteAusZugriff(zugriff ? jwtPayload(zugriff) : null),
    faehigkeiten: faehigkeitenAusHuelle(faehigkeiten)
  };
  if (!meldungNoetig(gemeldet, neu)) return;
  try {
    // Ohne Fähigkeiten (ältere Hülle) fehlt das Feld ganz — der Server liest
    // das als „unbekannt" und bleibt beim vorsichtigen Riegel
    // (`fcm_empfaenger.py`).
    const body = {
      token,
      geraet_id: pushGeraetId(),
      ...(neu.faehigkeiten ? { faehigkeiten: neu.faehigkeiten } : {})
    };
    await request<void>('/voip/token', { method: 'POST', body }, cloud());
    gemeldet = neu;
  } catch (e) {
    // Keine Sitzung, offline, oder der Server kennt die Route nicht (älterer
    // Stand) — still. `gemeldet` wird absichtlich NICHT gesetzt, damit der
    // nächste Start (oder der Hörer) denselben Token erneut anbietet.
    console.warn('[voip] Token-Anmeldung fehlgeschlagen', e);
  }
}

/** Nach dem Anmelden aufrufen. Die Hörer hängen nur beim ersten Mal ein —
 *  das App-Layout ruft nach jeder Anmeldung im selben Dokument erneut. */
export function voipTokenVerfolgen(): void {
  if (!isCapacitorIOS()) return;
  if (!verfolgt) {
    verfolgt = true;
    void anrufNativ.addListener('voipToken', (daten) => void melden(daten));
    // Zurück im Vordergrund: hat sich die Kette inzwischen geändert, zieht
    // die Zeile nach (S3). Sonst tut `melden` nichts.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') voipTokenNachmelden();
    });
  }
  voipTokenNachmelden();
}

/** Den Token neu anbieten — `melden` entscheidet, ob er wirklich rausgeht.
 *  Nach einem Passwortwechsel zu rufen (neue Kette, S3). */
export function voipTokenNachmelden(): void {
  if (!isCapacitorIOS()) return;
  void anrufNativ
    .voipToken()
    .then((daten) => melden(daten))
    .catch(() => undefined);
}

/** Beim Abmelden: die Registrierung dieses Geräts entfernen.
 *
 *  `bearerOverride` aus demselben Grund wie bei `abmeldeFcmToken` — im
 *  Sign-Out-Pfad sind die Token schon gelöscht, wenn dieser Aufruf feuert.
 *  Es muss der CLOUD-Token sein, auch wenn gerade ein Self-Host aktiv ist. */
export async function voipTokenAbmelden(bearerOverride?: string): Promise<void> {
  if (!isCapacitorIOS()) return;
  try {
    const { token } = await anrufNativ.voipToken();
    if (!token) return;
    await request<void>(
      '/voip/token',
      {
        method: 'DELETE',
        body: { token },
        ...(bearerOverride
          ? { auth: false, headers: { Authorization: `Bearer ${bearerOverride}` } }
          : {})
      },
      cloud()
    );
  } catch {
    /* best-effort — Sign-Out darf daran nicht hängen */
  } finally {
    gemeldet = null;
  }
}
