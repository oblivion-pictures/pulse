/**
 * FCM-Push-Empfang in der Android-App (Übergabe P0.1) und der iOS-Hülle.
 *
 * Das Plugin (`@capacitor-firebase/messaging`) erreicht der Klient über
 * `fcmPlugin.ts` (kein Paket-Import, Begründung dort).
 *
 * Aufgabenteilung laut Plugin-Doku (v8):
 *  - App im HINTERGRUND/zu: das System zeigt die Meldung selbst an — kein
 *    eigener Anzeigecode nötig.
 *  - App im VORDERGRUND: `notificationReceived` feuert, aber die Nachricht
 *    erscheint ohnehin inline über den WS (`dm_bump`/`message`/Postfach) —
 *    eine zusätzliche Meldung wäre doppelt. Bewusst kein Listener. Anruf-
 *    Pushs fängt die Android-Hülle vorher ab (`PushDienst.java`) und reicht
 *    sie über `Anruf.ausstehendeAktion()` weiter (`anrufe/anrufHuelle.ts`).
 *  - TAP auf die Systemmeldung: `notificationActionPerformed` → Deep-Link
 *    (`mitteilungsZiel.ts`).
 *  - Neuer Token (Rotation): `tokenReceived` → erneut melden.
 *
 * **Die Hörer hängen einmal je Seitenleben** (`installiert`, `hoererBereit`).
 * Bis zum 2026-10-20 hing `installiereFcmPush` Tipp- und Sichtbarkeits-Hörer
 * bei jedem Mount des App-Layouts neu an (am Code gefolgert, nicht am Gerät
 * nachgestellt): nach Abmelden und Anmelden im selben Dokument lief ein Tipp
 * damit doppelt — samt einer Banner-Antwort —, und jede Rückkehr nach vorn
 * meldete den Token mehrfach.
 */

import { request } from '$lib/api/client';
import { serversStore } from '$lib/api/servers.svelte';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';
import { badgeNachziehen } from './badge';
import { berechtigungsblatt } from './berechtigung.svelte';
import {
  mitteilungenBeimStartFragen,
  mitteilungenNachAnlassFragen,
  type Huelle,
  type Stand
} from './berechtigungRegel';
import { pushGeraetId } from './geraeteKennungPush';
import { fcmPlugin, type FcmPlugin } from './fcmPlugin';
import { zeigAn } from './mitteilungsTipp';
import { anrufAndroid } from './anrufNativ';
import { mitFrist, SPRACHE_FRIST_SOFORT_MS } from './brueckenFrist';
import { faehigkeitenAusHuelle } from './voipMeldung';
import { zugestellteMeldungenEntfernen } from './zugestellteMeldungen';
import { readState } from '$lib/stores/readState.svelte';

/**
 * Muss zum Backend-Kanal passen: der Versand ordnet die Meldung über
 * `AndroidNotification.channel_id` hier ein (dcc_chat_gateway/fcm.py).
 */
const KANAL_ID = 'messages';

/**
 * **An die CLOUD, nicht an den aktiven Server.** Pushes verschickt nur sie —
 * sie gelten DMs (`fcm.py::fan_out_fcm_dm_push`), und DMs sind Cloud-only.
 * Mit einem Self-Host davor landete der Token bis zum 2026-10-11 dort, und
 * die Cloud kannte ihn nie (dieselbe Klasse wie VoIP-Token und Badge,
 * Bughunt T2).
 */
function cloud(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/**
 * Was die Android-Hülle von sich sagt (`anruf_push`, `texte_lokal`) — der
 * Server richtet danach aus, was er an dieses Gerät schickt. Auf Android IMMER
 * eine Liste: eine ältere Hülle kennt die Methode nicht (der Ruf wird
 * abgelehnt), dann die leere. Ausserhalb von Android `null` — das Feld fehlt
 * dann ganz, iOS meldet seine Fähigkeiten mit dem VoIP-Token (`voipToken.ts`).
 */
async function huellenFaehigkeiten(): Promise<string[] | null> {
  if (!isCapacitorAndroid()) return null;
  try {
    const antwort = await mitFrist(
      anrufAndroid.faehigkeiten(),
      SPRACHE_FRIST_SOFORT_MS,
      'faehigkeiten'
    );
    return faehigkeitenAusHuelle(antwort?.faehigkeiten) ?? [];
  } catch {
    return [];
  }
}

/** `token`: schon bekannt (Rotation über `tokenReceived`), sonst geholt. */
async function meldeAn(fcm: FcmPlugin, token?: string): Promise<void> {
  const aktuell = token ?? (await fcm.getToken()).token;
  const faehigkeiten = await huellenFaehigkeiten();
  await request<void>(
    '/fcm/token',
    {
      method: 'POST',
      body: {
        token: aktuell,
        geraet_id: pushGeraetId(),
        ...(faehigkeiten ? { faehigkeiten } : {})
      }
    },
    cloud()
  );
}

/** Die Anmeldung samt Tipp-Hörer, sobald `installiereFcmPush` lief — für die
 *  Stellen, an denen die Erlaubnis gerade erst erteilt wurde. */
let anmeldenNachErlaubnis: (() => void) | null = null;

/**
 * Den Token unter der Anmelde-Kette melden, die das Gerät JETZT trägt — nach
 * einem Passwortwechsel zu rufen (Nachtrag zu iOS-Bughunt 2, C2). Der Wechsel
 * gibt diesem Gerät eine neue Kette und löscht die alte am Server; bis zur
 * nächsten Rückkehr in den Vordergrund hinge die Zeile an der alten, und der
 * Abgleich des chat-gateway (`geraetetoken_abgleich.py`) löschte sie als
 * beendet — ein Gerät, das angemeldet bleibt, bekäme keine Banner mehr.
 * Gegenstück zu `voipTokenNachmelden` (S3). Ohne Hülle ein No-op.
 */
export function fcmTokenNachmelden(): void {
  anmeldenNachErlaubnis?.();
}

let installiert = false;
let aktivesPlugin: FcmPlugin | null = null;
let hoererBereit = false;
let anmeldung: Promise<void> | null = null;

/**
 * Beim App-Start verkabeln (app/+layout.svelte): Token holen + melden,
 * Tap-Listener registrieren. Best-effort in jedem Schritt — ohne Firebase-
 * Konfiguration, vor der Anmeldung oder ohne erteilte Berechtigung bleibt
 * alles still (kein Crash, kein Log-Spam). Nach jedem Resume wird die
 * Token-Meldung wiederholt (idempotent), damit eine Anmeldung NACH dem
 * App-Start den Token nachreicht.
 */
export function installiereFcmPush(): void {
  // iOS-Hülle nutzt dieselbe Plugin-Schnittstelle und denselben
  // /fcm/token-Endpunkt — der Server-Versand unterscheidet nur am Token
  // (APNs braucht den Auth-Key im Firebase-Projekt, seit 2026-10-06 drin).
  if (!isCapacitorAndroid() && !isCapacitorIOS()) return;
  const fcm = fcmPlugin();
  if (!fcm) return;
  // Das App-Layout ruft nach jeder Anmeldung im selben Dokument erneut — die
  // Seiten-Hörer nur beim ersten Mal, die Token-Meldung jedes Mal (sie
  // gehört dann dem neu angemeldeten Konto).
  if (!installiert) {
    installiert = true;
    aktivesPlugin = fcm;
    anmeldenNachErlaubnis = meldeBestEffort;
    // Nach Login/Resume: Token nachmelden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') meldeBestEffort();
    });
    // Eine gescheiterte Token-Meldung (offline, Deploy-Fenster) wartet auf den
    // nächsten Resume — ein Gerät, das im Vordergrund wieder Netz bekommt, soll
    // nicht erst dafür weggewischt werden. Nur iOS: Android bleibt, wie es war.
    if (isCapacitorIOS()) window.addEventListener('online', meldeBestEffort);
    // Gelesen ⇒ die System-Meldungen dieser Unterhaltung wegräumen.
    readState.beimLesen(zugestellteMeldungenEntfernen);
  }
  meldeBestEffort();
}

/** Die Plugin-Hörer — einmal je Seitenleben, s. Modulkopf. */
function hoererHaengen(fcm: FcmPlugin): void {
  if (hoererBereit) return;
  hoererBereit = true;
  void fcm.addListener('notificationActionPerformed', zeigAn);
  // Rotation: Firebase vergibt einen neuen Token. Ohne diesen Hörer erfuhr
  // der Server davon erst bei der nächsten Rückkehr nach vorn; bis dahin
  // gingen seine Pushes an den alten.
  void fcm.addListener('tokenReceived', ({ token }) => {
    void meldeAn(fcm, token).catch(() => undefined);
  });
}

function meldeBestEffort(): void {
  const fcm = aktivesPlugin;
  if (!fcm) return;
  anmeldung ??= (async () => {
    try {
      if (isCapacitorAndroid()) {
        await fcm.createChannel({
          id: KANAL_ID,
          name: 'Nachrichten',
          importance: 4, // HIGH — Pop-up + Ton, Discord-artig
          visibility: 1 // PUBLIC — auf dem Sperrbildschirm lesbar
        });
      }
      // **Auf iOS wird hier NICHT nach der Erlaubnis gefragt** (2026-10-08,
      // iOS-Punkt 36). Diese Stelle läuft beim Start, also bevor der Nutzer
      // die App gesehen hat — und der iOS-Dialog erscheint genau EINMAL.
      // Ein „nein" aus Reflex war damit dauerhaft. Gefragt wird dort mit
      // Vorerklärung und erst nach einem Anlass, s. `mitteilungenAnfragen`.
      // **Android fragt weiter hier, beim Start** — wie vor der iOS-Hülle
      // (Eigentümer-Entscheid 2026-10-16, `berechtigungRegel.ts`).
      let perms = await fcm.checkPermissions();
      if (perms.receive !== 'granted' && mitteilungenBeimStartFragen(huelle())) {
        perms = await fcm.requestPermissions();
      }
      if (perms.receive !== 'granted') return;
      // **Die Hörer hängen VOR der Netzmeldung** (iOS-Review B7): bei
      // offline oder 401 wirft `meldeAn`, und stünde der Tipp-Hörer
      // dahinter, bliebe ein Tipp auf ein Banner ohne Wirkung, bis ein
      // Resume die Meldung nachholt. Der Tipp braucht das Netz nicht.
      hoererHaengen(fcm);
      await meldeAn(fcm);
    } catch {
      // Kein Firebase-Setup / keine Session / offline — bewusst still.
    } finally {
      anmeldung = null;
    }
  })();
}

function huelle(): Huelle {
  if (isCapacitorIOS()) return 'ios';
  return isCapacitorAndroid() ? 'android' : null;
}

/** Plugin-Auskunft in unseren Stand übersetzt (`berechtigungRegel.ts`).
 *  `prompt` heisst „noch offen" — nur dort kann ein Dialog noch etwas
 *  ändern. */
function alsStand(receive: 'granted' | 'denied' | 'prompt'): Stand {
  switch (receive) {
    case 'granted':
      return 'erteilt';
    case 'denied':
      return 'verweigert';
    default:
      return 'offen';
  }
}

/**
 * Nach der Mitteilungs-Erlaubnis fragen — mit Vorerklärung und erst nach einem
 * Anlass (iOS-Liste Punkt 36).
 *
 * Gerufen wird das nach einer gesendeten Nachricht, nicht beim Start. Grund:
 * der iOS-Dialog erscheint GENAU EINMAL, und beim Start hat der Nutzer keinen
 * Grund, ja zu sagen. Die Regel (wie viele Nachrichten, wie lange ein
 * „später" hält) steht in `berechtigungRegel.ts`.
 *
 * Mehrfache Aufrufe sind billig: liegt die Erlaubnis vor oder ist sie
 * verweigert, kehrt die Funktion vor jeder Frage zurück; fehlt der Anlass oder
 * wurde die Erklärung schon weggetippt, sagt die Regel „nicht", und
 * `requestPermissions` wird gar nicht erreicht. Still bei jedem Fehler — eine
 * Mitteilungs-Erlaubnis ist nichts, wofür man eine Fehlermeldung zeigt.
 */
export async function mitteilungenAnfragen(): Promise<void> {
  // Nur iOS: Android fragt beim Start (`installiereFcmPush`), ein zweiter
  // Anlauf nach dem Senden wäre dort neues Verhalten.
  if (!mitteilungenNachAnlassFragen(huelle())) return;
  const fcm = fcmPlugin();
  if (!fcm) return;
  try {
    const { receive } = await fcm.checkPermissions();
    const stand = alsStand(receive);
    if (stand !== 'offen') return;
    if (!(await berechtigungsblatt.fragen('mitteilungen', stand))) return;
    const neu = await fcm.requestPermissions();
    if (neu.receive !== 'granted') return;
    await nachErteilterErlaubnis(fcm);
  } catch {
    /* Kein Firebase-Setup / keine Session / offline — bewusst still. */
  }
}

async function nachErteilterErlaubnis(fcm: FcmPlugin): Promise<void> {
  // Bis eben hat `badgeSetzen` nichts getan (es fragt nie selbst) — die
  // Plakette jetzt nachziehen, nicht erst bei der nächsten Nachricht.
  badgeNachziehen();
  // Über die Anmeldung beim Start, damit auch der Tipp-Hörer hängt — der
  // hing bisher erst nach dem nächsten Vordergrund.
  if (anmeldenNachErlaubnis) anmeldenNachErlaubnis();
  else await meldeAn(fcm);
}

/** Stand der Mitteilungs-Erlaubnis dieses Geräts; `null` ohne Plugin oder
 *  bei einem Fehler. Für die Einstellungen (`HuelleMitteilungen.svelte`). */
export async function mitteilungenStand(): Promise<Stand | null> {
  const fcm = fcmPlugin();
  if (!fcm) return null;
  try {
    return alsStand((await fcm.checkPermissions()).receive);
  } catch {
    return null;
  }
}

/**
 * Aus den Einstellungen der App: direkt nach der Erlaubnis fragen
 * (iOS-Bughunt 2, F3). **Ohne Vorerklärung** — wer in den Einstellungen auf
 * „Erlauben" tippt, hat den Grund vor Augen, und ein „später" davor gäbe es
 * hier nicht. Liefert den Stand danach; `null` ohne Plugin oder bei einem
 * Fehler.
 */
export async function mitteilungenJetztErlauben(): Promise<Stand | null> {
  const fcm = fcmPlugin();
  if (!fcm) return null;
  try {
    const stand = alsStand((await fcm.requestPermissions()).receive);
    if (stand === 'erteilt') await nachErteilterErlaubnis(fcm);
    return stand;
  } catch {
    return null;
  }
}

/**
 * Token serverseitig abmelden (Sign-Out). `bearerOverride`: gleiche Begründung
 * wie bei `deletePushSubscription` — `clearTokens()` ist im Sign-Out-Pfad
 * schon gelaufen, wenn dieser (dynamisch importierte) Aufruf feuert.
 */
export async function abmeldeFcmToken(bearerOverride?: string): Promise<void> {
  const fcm = fcmPlugin();
  if (!fcm) return;
  try {
    const { token } = await fcm.getToken();
    await request<void>(
      '/fcm/token',
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
  }
}
