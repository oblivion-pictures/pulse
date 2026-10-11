import { request } from '$lib/api/client';
import { serversStore } from '$lib/api/servers.svelte';
import { badgeSetzen } from './badge';
import {
  serverHatGezaehlt,
  serverStandUnsicher,
  wartezeit,
  type Drosselstand
} from './badgeDrossel';
import { ungelesenAblegen, ungelesenLeeren } from './ungelesenWidget';

/** Drosselstand dieser Sitzung — was zuletzt gemeldet wurde und wann. */
const stand: Drosselstand = { letzterWert: null, letzteZeit: 0, bereit: false };
/** Zuletzt GERECHNETER Wert — auch wenn er nicht gemeldet wurde. Den braucht
 *  `melden`, um später nachzumelden: als Nachzügler der Drossel und nach der
 *  Freigabe (`badgeMeldungFreigeben`). */
let gerechnet: number | null = null;
/** Steht ein Nachmelden an? `sofort` nach dem Wiederverbinden
 *  (`badgeNachVerbindung`), `gedrosselt` nach einer Zustellung bei wacher App
 *  (`badgeNachZustellung`). */
let nachmelden: 'sofort' | 'gedrosselt' | null = null;
/** Ein vorgemerkter Nachzügler, weil die Drossel die Meldung aufgeschoben hat. */
let nachzuegler: ReturnType<typeof setTimeout> | null = null;

/**
 * Den eigenen Ungelesen-Stand an den Server melden, damit er ihn im Push
 * mitschicken kann (`aps.badge`).
 *
 * **Warum der Klient meldet und der Server nicht rechnet:** Bei
 * verschlüsselten DMs — dem Normalweg — kennt der Server die Zahl nicht
 * (Begründung im Modulkopf von `services/chat-gateway/.../badgezaehler.py`).
 * Solange die App wach ist, ist dieser Klient die Wahrheit; der Serverzähler
 * ist nur die Fortschreibung für die Zeit, in der niemand rechnen kann.
 *
 * **Gilt für JEDE Plattform, nicht nur die iOS-Hülle.** Wer am Rechner liest,
 * soll damit die Plakette am Telefon abräumen — dieselbe Erwartung wie bei
 * WhatsApp Web. Der Aufruf geht an die CLOUD: nur sie verschickt Pushes (sie
 * gelten DMs, und die sind Cloud-only), also führt nur sie den Zähler. Bis
 * zum 2026-10-11 ging er an den AKTIVEN Server — mit einem Self-Host davor
 * setzte das dessen Zähler zurück, während der in der Cloud weiter wuchs
 * (Bughunt T2).
 *
 * **Auch das Icon selbst und das Widget bekommen die Zahl erst, wenn sie
 * etwas bedeutet** (`bereit`, s. `badgeDrossel.ts`). Bis zum 2026-10-11
 * setzte die Oberfläche das Icon ungeprüft: beim Start rechnete sie vor dem
 * Laden 0 und räumte damit die Plakette ab, die der letzte Push gesetzt hatte
 * — offline blieb sie danach auf 0 (iOS-Bughunt 2, C7).
 */
export function badgeMelden(wert: number): void {
  gerechnet = wert;
  if (stand.bereit) {
    ungelesenAblegen(wert);
    void badgeSetzen(wert);
  }
  melden();
}

/** Den zuletzt gerechneten Wert melden — jetzt, später oder gar nicht, wie
 *  die Drossel es sagt. Später heisst: ein Nachzügler nach Ablauf der Frist
 *  (iOS-Bughunt 2, C3), statt den Wert zu verwerfen. */
function melden(): void {
  if (gerechnet === null) return;
  const wert = gerechnet;
  const jetzt = Date.now();
  const warten = wartezeit(stand, wert, jetzt);
  if (warten === null) return;
  if (warten > 0) {
    nachzuegler ??= setTimeout(() => {
      nachzuegler = null;
      melden();
    }, warten);
    return;
  }
  const vorher = { wert: stand.letzterWert, gezaehlt: stand.gezaehlt };
  stand.letzterWert = wert;
  stand.letzteZeit = jetzt;
  stand.gezaehlt = false;
  void request<void>(
    '/fcm/badge',
    { method: 'POST', body: { anzahl: wert } },
    { serverId: serversStore.cloudId() }
  ).catch(() => {
    // Fehlgeschlagen (offline, 429, nicht angemeldet): den Merker
    // zurücknehmen, sonst gilt ein nie angekommener Wert als gemeldet und
    // der nächste Durchlauf schweigt über denselben Stand.
    if (stand.letzterWert === wert) {
      stand.letzterWert = vorher.wert;
      stand.gezaehlt = vorher.gezaehlt;
    }
  });
}

/**
 * Freigabe: Ab jetzt kann dieser Klient seine Zahl verteidigen.
 *
 * Gerufen, sobald der Postfach-Abholweg einer Sitzung durch ist (auch wenn
 * er wegen abgeschalteter Krypto-Schalter gar nichts zu tun hatte) —
 * `ws/handlers/chat.ts::postfachAbholenUndAnzeigen`. Vorher ist die
 * Ungelesen-Rechnung des Klienten noch nicht geladen und seine 0 bedeutet
 * „weiss ich nicht", nicht „alles gelesen" (s. `badgeDrossel.ts`).
 */
export function badgeMeldungFreigeben(): void {
  stand.bereit = true;
  if (gerechnet !== null) {
    ungelesenAblegen(gerechnet);
    void badgeSetzen(gerechnet);
  }
  if (nachmelden === null) return;
  if (nachmelden === 'sofort') serverStandUnsicher(stand);
  else serverHatGezaehlt(stand);
  nachmelden = null;
  // Hat sich die Zahl durch das Abholen geändert, meldet der `$effect` sie
  // gleich selbst. Hat sie sich NICHT geändert, läuft er nicht — dann
  // meldet dieser Aufruf sie (im nächsten Takt, damit der `$effect` mit der
  // frischen Zahl zuerst dran ist; hat er gemeldet, tut `melden` nichts).
  setTimeout(melden, 0);
}

/**
 * Die Verbindung zur Cloud steht (wieder) — `ready`. Das nächste Freigeben
 * meldet den Stand neu, auch wenn er gleich geblieben ist, und zwar sofort:
 * der Server hat in der Zwischenzeit womöglich selbst hochgezählt
 * (`serverStandUnsicher`, Bughunt T12).
 */
export function badgeNachVerbindung(): void {
  nachmelden = 'sofort';
}

/**
 * Eine Nachricht ist zugestellt worden (`postfach_neu`), während diese App
 * wach ist. Der Server pusht sie trotzdem an jedes iOS-Gerät und zählt
 * dabei hoch (iOS-Bughunt 2, C1) — das nächste Freigeben meldet den Stand
 * deshalb neu, gedrosselt (`serverHatGezaehlt`).
 */
export function badgeNachZustellung(): void {
  nachmelden ??= 'gedrosselt';
}

/** Nach dem Abmelden: der nächste Anmelder soll seinen Stand frisch melden
 *  dürfen, auch wenn er zufällig dieselbe Zahl hat — und erst wieder, wenn
 *  SEINE Lage geladen ist. Widget und Icon gehen dabei auf 0 (sie gehören dem
 *  Gerät, nicht dem Konto, s. `ungelesenLeeren`). */
export function badgeMeldungZuruecksetzen(): void {
  stand.letzterWert = null;
  stand.letzteZeit = 0;
  stand.bereit = false;
  stand.gezaehlt = false;
  gerechnet = null;
  nachmelden = null;
  if (nachzuegler !== null) clearTimeout(nachzuegler);
  nachzuegler = null;
  ungelesenLeeren();
  void badgeSetzen(0);
}
