/**
 * Standplatz-Geräte — **welche Bildschirme es gibt und wie man einen holt**.
 *
 * Herausgelöst, weil es seit dem Menü im Player-Fenster **zwei** Stellen gibt,
 * an denen jemand einen Bildschirm anfordert:
 *
 * * die Geräteansicht in der App (`DeviceView.svelte`) — vor dem Übernehmen,
 * * das Menü am Griff im Player-Fenster (`overlay/fernbedienung.rs`) — während
 *   man steuert, denn dort schaut der Steuernde gerade hin.
 *
 * Beide brauchen dieselbe Entscheidung: läuft dieser Schirm schon, hol sein
 * Fenster nach vorne; läuft er nicht, wecke ihn und öffne das Fenster, sobald
 * das Bild da ist. Ein zweiter Nachbau davon liefe unweigerlich auseinander —
 * und zwar an der unauffälligsten Stelle, dem Erkennen, ob ein Schirm schon
 * läuft.
 *
 * **Das Player-Fenster entscheidet nichts selbst.** Es kennt weder das Gerät
 * noch die Sitzung beim Server; es meldet nur „der Nutzer hat Bildschirm 2
 * gewählt". Dasselbe Muster wie beim Chat-Knopf und bei „Fernsteuerung
 * beenden".
 */

import type { Device, DeviceMonitor } from '$lib/api/devices';
import { geraetWecken } from './wecken';
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { stroemeVon, stromFuer } from './schirmZuordnung';
import { openedTiles } from '$lib/stream/openedTiles.svelte';
import { hqTileId } from '$lib/stream/hqTile';
import { nativeWindowRequests } from '$lib/player/wuensche.svelte';
import { nativePlayerSessions } from '$lib/player/store.svelte';
import { remoteSession } from '$lib/remote/session.svelte';
import { weckFehlerWacht, type Abbruch } from '$lib/remote/wachten';
import { weckFehlerText } from '$lib/remote/fehlertexte';
import { gatewayForServer } from '$lib/ws/connection';
import { activeServer } from '$lib/stores/active-server.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { darfGeraetSteuern, darfGeraetZusehen } from './zugang';
import { WECKFEHLER_FENSTER_MS } from '$lib/remote/fehlerCodes';
import { m } from '$lib/paraglide/messages.js';

// Bildschirmliste und Zuordnung stehen seit 2026-10-16 in `schirmZuordnung.ts`
// (Grössen-Regel); die bisherigen Einfuhren aus dieser Datei bleiben gültig.
export {
  schirmeVon,
  schirmeVonFuerFenster,
  type SchirmStand,
  type SchirmStandFuerFenster,
} from './schirmZuordnung';

/** Darf der angemeldete Nutzer dieses Gerät wecken und steuern? Seit
 *  2026-10-16 entscheidet das die Freigabeliste (`Device.steuerbar`, vom
 *  Server je Betrachter), nicht mehr `REMOTE_CONTROL` — Regel in `zugang.ts`. */
function darfIch(device: Device): boolean {
  return darfGeraetSteuern(device, currentServerUserId());
}

/**
 * Wie lange auf das erste Bild gewartet wird.
 *
 * Grosszügig: der Rechner muss den Encoder hochfahren, und auf einer
 * ausgelasteten Maschine dauert das. Zu kurz gewählt hiesse, dass die
 * Oberfläche „hat nicht geantwortet" sagt, während der Stream gerade anläuft —
 * der schlechteste Zeitpunkt für eine Absage.
 */
const WARTEN_MS = 25_000;


/**
 * Das Fenster eines laufenden Stroms öffnen (oder nach vorne holen).
 *
 * **Beides gehört hier zusammen** (2026-08-16): die Kachel aufmachen *und* sie
 * ins eigene Player-Fenster schicken. Ein Gerät weckt man, um es zu übernehmen
 * — und die Fernsteuerung gibt es ausschliesslich im nativen Fenster
 * (Zeigerfang, rohe Scancodes, der Anfrage-Knopf). Bis hierher öffnete der
 * Weckruf nur die Kachel; das Fenster kam erst über den Abkoppel-Knopf oder
 * über `playerSettings.useNativePlayer`, eine Vorgabe ohne Oberfläche, die per
 * Vorgabe aus ist. Der Weckruf endete also im `<video>`-Weg — ohne
 * Übernahme-Weg und ohne die Latenzmassnahmen des Fern-Modus.
 *
 * Fehlt das Player-Binary (Browser, unfertiger Bau), ist die Anforderung
 * folgenlos: `useNativePlayback` prüft zusätzlich `isPlayerAvailable()` und
 * bleibt sonst beim `<video>`. Der Zuschauer kann sie danach jederzeit mit dem
 * Abkoppel-Knopf zurücknehmen — `zugemacht` gewinnt gegen diese Anforderung,
 * bis der nächste Weckruf kommt.
 */
function fensterOeffnen(device: Device, slot: number, uebernahme = true): void {
  openedTiles.open('hq', device.channel_id, hqTileId(device.owner_user_id, slot));
  nativeWindowRequests.request(device.channel_id, device.owner_user_id, slot);
  // **Und nach vorne damit** (Bughunt 2026-08-16). Modulkopf und der Vertrag
  // im Player (`overlay/typen.rs`) versprechen beides — „hol sein Fenster nach
  // vorne" —, aber die Anforderung oben ist für ein schon offenes Fenster ein
  // No-op: sie ist bereits erfüllt. Wer aus der Geräteansicht oder aus dem Menü
  // am Griff einen laufenden Bildschirm wählte, sah deshalb gar nichts
  // passieren, obwohl das Fenster hinter der App lag.
  nativePlayerSessions.get(device.channel_id, device.owner_user_id, slot)?.focus();
  if (uebernahme) uebernehmen(device, slot);
}

/**
 * Die Fernsteuerung anfordern, sobald das Bild da ist.
 *
 * **Warum das hier selbsttätig geschieht und nicht am Knopf des Zuschauers**
 * (Änderung 2026-08-16): bei einem Standplatz-Gerät heisst der eine Knopf
 * „Übernehmen", und genau das soll er tun. Die Zustimmung ist bei
 * diesen Geräten **vorverlegt** — sie steht in der Freigabeliste des
 * Besitzers, lange bevor jemand klickt, und das Gerät zeigt seit 2026-10-16
 * keinen Dialog mehr. Ein zweiter Knopf „Fernsteuerung anfragen" fragte also
 * etwas, das schon beantwortet ist, und liesse den Steuernden vor einem Bild
 * sitzen, das er nicht bedienen kann.
 *
 * **Nach dem Bild, nicht davor.** Der Grund aus `wecken.ts` bleibt unberührt:
 * eine Sitzungszusage darf nicht an einer Encoder-Initialisierung hängen.
 * Deshalb weiterhin zwei Vorgänge — wecken, warten, und erst wenn das Fenster
 * aufgeht, die unveränderte `remote_request`. Scheitert das Wecken, gab es nie
 * eine Anfrage.
 *
 * Zwei Fälle, die von selbst richtig laufen: ein **zweiter Bildschirm** fordert
 * nichts nach (`request()` springt bei laufender Sitzung früh zurück, und der
 * Drahtvertrag trägt die Platznummer in jeder Nachricht — eine Sitzung bedient
 * alle Schirme), und **ohne Freigabe** wird gar nicht erst gefragt: der
 * Gateway wiese es mit 4062 ab (seit 2026-10-16; vorher hing das an
 * `REMOTE_CONTROL`).
 *
 * Der Knopf an der Kachel bleibt bestehen — er ist danach das „Beenden".
 */
function uebernehmen(device: Device, slot: number): void {
  if (!darfIch(device)) return;
  // **Nicht dazwischenfunken** (2026-08-16): steuert schon jemand, ist der
  // Gateway ohnehin dagegen (4054, eine Sitzung je Gerät) — der Zuschauer bekäme
  // für einen Klick, mit dem er nur zusehen wollte, eine Fehlermeldung. Steuert
  // man selbst, springt `request()` bei laufender Sitzung früh zurück; dieser
  // Riegel meint also genau den Fall „ein anderer hat ihn".
  if (device.state === 'busy') return;
  remoteSession.request(device.channel_id, device.owner_user_id, slot, false, device.id);
}

/**
 * **P2P-Übernahme anfordern** — der zweite Knopf unter „Übernehmen".
 *
 * Der Ablauf ähnelt dem gewohnten, mit zwei bewussten Unterschieden: der
 * Weckruf trägt den P2P-Wunsch (der Sidecar des Geräts startet im Wartezustand,
 * ohne Serverkontakt), und die Anfrage geht **sofort** nach dem Weckruf hinaus
 * statt erst nach dem ersten Bild — es gibt kein `stream:active`, auf das man
 * warten könnte, denn der Server sieht diesen Stream nicht. Das Bild selbst
 * entsteht erst nach der Zusage in der Verhandlung (`$lib/remote/direktbild`).
 *
 * Dieselben Riegel wie [`uebernehmen`]: ohne Freigabe gar nicht erst fragen
 * (der Gateway wiese ab), bei „busy" nicht dazwischenfunken.
 */
export function direktUebernehmen(device: Device): void {
  if (!darfIch(device)) return;
  if (device.state === 'busy') return;
  // Der Weckruf und die Anfrage laufen über dieselbe Verbindung; ist sie zu,
  // schlägt auch die Anfrage fehl und setzt dieselbe lesbare Offline-Meldung.
  // Deshalb kein eigener Fehlerzweig für den Ruf — „gescheitert" doppelt
  // gemeldet wäre Lärm, gar nicht gemeldet eine tote Schaltfläche.
  geraetWecken(activeServer.serverId, device.id, undefined, true);
  remoteSession.request(device.channel_id, device.owner_user_id, 0, true, device.id);
}

/**
 * Einem laufenden Bildschirm **nur zusehen** — ohne Übernahme-Anfrage.
 *
 * Der zweite der beiden Wege, die es an einem Gerät gibt, und der leisere:
 * Zusehen braucht die Sicht auf den Kanal und — seit 2026-10-16 — dass gerade
 * jemand steuert (der Besitzer darf immer, `zugang.ts::darfGeraetZusehen`;
 * der Server prüft es an `/whep`). Übernehmen braucht eine Freigabe. Sie zu
 * vermischen hiess, dass ein Dritter eine Sitzung anfragte, obwohl er bloss
 * das Bild wollte.
 *
 * Läuft der Bildschirm nicht, geschieht nichts: was niemand überträgt, kann
 * man nicht ansehen, und wecken darf hier bewusst nur, wer auch übernehmen darf.
 */
export function zusehen(device: Device, mon: DeviceMonitor): void {
  const laufend = stromFuer(device, mon);
  if (!laufend) return;
  fensterOeffnen(device, laufend.slot, false);
}

/**
 * Der Schlüssel eines Wunsches: **Gerät UND Bildschirm**.
 *
 * **Der Grund** (Bughunt 2026-08-16): geschlüsselt war nur nach Gerät, während
 * die Knöpfe je Bildschirm freigegeben sind. Wer Monitor 2 anforderte und kurz
 * darauf Monitor 3, überschrieb damit den ersten Wunsch — für einen der beiden
 * ging nie ein Fenster auf, und sein Zeitgeber lief ins Leere. Genau der
 * Ablauf, für den die Bildschirmliste gebaut ist.
 */
function schluessel(deviceId: string, index: number): string {
  return `${deviceId}:${index}`;
}

/**
 * Worauf gerade gewartet wird — je Gerät und Bildschirm ein Wunsch.
 *
 * Als Modul-Zustand und nicht in der Komponente, weil die Anforderung aus dem
 * Player-Fenster kommen kann, während die Geräteansicht gar nicht gemountet
 * ist. Die Wartezeit läuft dann trotzdem, und das Fenster geht auf, sobald das
 * Bild da ist. Der Preis dafür steht in [`reset`]: was einen Serverwechsel
 * überdauern kann, muss dort auch fallen gelassen werden.
 */
class SchirmWarten {
  /** `deviceId:index` → Bildschirm, auf den gewartet wird. */
  offen = $state<Record<string, DeviceMonitor>>({});
  /**
   * `deviceId:index` → welche Plätze beim Anfordern schon liefen.
   *
   * **Der Grund** (Bughunt 2026-08-16): das Netz in [`einloesen`] nahm
   * irgendeinen Strom dieses Geräts, falls der Name nicht traf — und beim
   * Dazuschalten eines zweiten Bildschirms lief immer schon einer. Das Netz
   * griff also sofort, löste den Wunsch mit dem BEREITS offenen Fenster ein und
   * räumte ihn ab. Der dazugeschaltete Bildschirm bekam nie ein Fenster; der
   * Knopf sah aus, als hätte er nichts getan. Nur ein Strom, der beim
   * Anfordern noch nicht lief, kann der gemeinte sein.
   */
  readonly #vorher = new Map<string, Set<number>>();
  readonly #wecker = new Map<string, ReturnType<typeof setTimeout>>();
  /** Je Wunsch die Wacht auf eine Ablehnung des Weckrufs (`weckFehlerWacht`),
   *  und welcher Wunsch zuletzt einen Ruf hinausschickte: die Fehler-Rahmen
   *  tragen keine Gerätekennung, und ein gelungener Weckruf bekommt gar keine
   *  Antwort — ein Fehler gilt deshalb dem jüngsten Ruf, und nur, solange
   *  der höchstens [`WECKFEHLER_FENSTER_MS`] alt ist. **Bekannte Grenze:**
   *  zwei Rufe an verschiedene Geräte innerhalb einer Laufzeit zum Server —
   *  scheitert der erste, landet der Text beim zweiten. Das Fenster hält
   *  dagegen eine spätere 4056 einer Personen-Anfrage fern. */
  readonly #fehlerWacht = new Map<string, Abbruch>();
  #juengster: string | null = null;
  #juengsterUm = 0;
  /** Letzter Fehlschlag je Gerät, für die Anzeige. Bewusst nach Gerät und nicht
   *  nach Bildschirm: die Geräteansicht hat eine Fehlerzeile, keine je Knopf. */
  fehler = $state<Record<string, string>>({});

  /** Irgendein offener Wunsch dieses Geräts — für „wird geweckt…" am
   *  Haupt-Knopf, der keinen bestimmten Bildschirm meint. */
  wartetAuf(deviceId: string): DeviceMonitor | null {
    const treffer = Object.entries(this.offen).find(([k]) => k.startsWith(`${deviceId}:`));
    return treffer ? treffer[1] : null;
  }

  /** Wartet gerade jemand auf GENAU diesen Bildschirm? */
  wartetAufSchirm(deviceId: string, index: number): boolean {
    return schluessel(deviceId, index) in this.offen;
  }

  /**
   * Einen Bildschirm anfordern.
   *
   * Läuft er schon, geht sein Fenster sofort auf — ohne Weckruf. Der wäre zwar
   * harmlos (das Gerät verwirft ihn), aber der Umweg über „warten" liesse den
   * Knopf ohne Grund eine Sekunde lang beschäftigt aussehen.
   *
   * `ausdruecklich` trennt die beiden Wege, die hier zusammenlaufen: die
   * Bildschirmliste meint einen bestimmten Schirm und nennt seine Nummer, der
   * Haupt-Knopf („Übernehmen") meint dagegen „den, den du herzeigen
   * willst" und nennt keine — dort entscheidet das Standplatz-Profil des
   * Geräts (Begründung in `wecken.ts::quelleFuerMonitor`).
   */
  holen(device: Device, mon: DeviceMonitor, ausdruecklich = true): void {
    delete this.fehler[device.id];
    const laufend = stromFuer(device, mon);
    if (laufend) {
      // Auch hier die Regel aus `zugang.ts`: zusehen dürfen Besitzer, alle bei
      // belegtem Gerät — und wer steuern darf (er ist dann der Wecker, dem der
      // Server bis zum Sitzungsbeginn zusehen lässt). Sonst gäbe `/whep` 403.
      if (!darfIch(device) && !darfGeraetZusehen(device, currentServerUserId())) {
        this.fehler[device.id] = m.device_error_not_granted();
        return;
      }
      fensterOeffnen(device, laufend.slot);
      return;
    }
    // Wecken nur mit Freigabe — der Server lehnte sonst mit 4062 ab.
    if (!darfIch(device)) {
      this.fehler[device.id] = m.device_error_not_granted();
      return;
    }
    // `index: 0` ist der Ersatz-Eintrag ohne Bildschirmliste — dann ebenfalls
    // ohne Nummer wecken, und das Gerät nimmt, was sein Profil sagt.
    const nummer = ausdruecklich ? mon.index || undefined : undefined;
    // Der Server des Geräts ist der aktive: der Geräte-Speicher wird beim
    // Serverwechsel geleert (`stores/multi-server-reset.ts`), ein Gerät in der
    // Hand gehört also immer zur aktiven Verbindung.
    if (!geraetWecken(activeServer.serverId, device.id, nummer)) {
      this.fehler[device.id] = m.device_view_wake_failed();
      return;
    }
    const k = schluessel(device.id, mon.index);
    this.offen[k] = mon;
    this.#vorher.set(k, new Set(stroemeVon(device).map((s) => s.slot)));
    this.#fehlerWacht.get(k)?.();
    this.#juengster = k;
    this.#juengsterUm = Date.now();
    const conn = activeServer.serverId ? gatewayForServer(activeServer.serverId) : null;
    this.#fehlerWacht.set(
      k,
      weckFehlerWacht(conn, (code) => {
        if (this.#juengster !== k || Date.now() - this.#juengsterUm > WECKFEHLER_FENSTER_MS) return;
        this.#aufraeumen(k);
        this.fehler[device.id] = weckFehlerText(code) ?? m.device_view_wake_failed();
      }),
    );
    const alt = this.#wecker.get(k);
    if (alt) clearTimeout(alt);
    this.#wecker.set(
      k,
      setTimeout(() => {
        this.#aufraeumen(k);
        this.fehler[device.id] = m.device_view_wake_failed();
      }, WARTEN_MS),
    );
  }

  /**
   * Prüfen, ob ein erwartetes Bild da ist — aus einem Effect gerufen, weil die
   * Ströme asynchron erscheinen und der Klick noch nicht weiss, wann.
   *
   * Geht über ALLE offenen Wünsche dieses Geräts: es können mehrere sein, und
   * sie werden nicht der Reihe nach fertig.
   *
   * Liefert `true`, wenn mindestens ein Fenster geöffnet wurde.
   */
  einloesen(device: Device): boolean {
    let geoeffnet = false;
    for (const k of Object.keys(this.offen)) {
      if (!k.startsWith(`${device.id}:`)) continue;
      const ziel = this.offen[k];
      const vorher = this.#vorher.get(k) ?? new Set<number>();
      const strom =
        stromFuer(device, ziel) ??
        // Netz für den Fall, dass der Name nicht trifft: ein NEUER Strom dieses
        // Geräts ist besser als gar keiner. Neu heisst: er lief beim Anfordern
        // noch nicht — sonst löste das Netz den Wunsch sofort mit dem Bildschirm
        // ein, der ohnehin schon offen war (s. `#vorher`).
        streamPresence
          .streamsIn(device.channel_id)
          .find((s) => s.user_id === device.owner_user_id && !vorher.has(s.slot));
      if (!strom) continue;
      this.#aufraeumen(k);
      // Diesen Platz für die übrigen Wünsche DESSELBEN Geräts verbrauchen,
      // sonst löste ihr Netz sie mit demselben Strom ein — und der zweite
      // angeforderte Bildschirm bekäme wieder kein eigenes Fenster. Nur
      // dieses Gerät: Plätze sind je Übertragendem gezählt, bei einem anderen
      // Gerät verdeckte dieselbe Nummer einen fremden, gültigen Strom.
      for (const [rk, rest] of this.#vorher) {
        if (rk.startsWith(`${device.id}:`)) rest.add(strom.slot);
      }
      fensterOeffnen(device, strom.slot);
      geoeffnet = true;
    }
    return geoeffnet;
  }

  /**
   * Alles fallen lassen — Abmelden und Serverwechsel.
   *
   * **Warum das gebraucht wird** (Bughunt 2026-08-16): dieser Zustand ist ein
   * Modul-Singleton und überlebt beides. Ohne Rücknahme liefen die Zeitgeber
   * eines Wunsches weiter, schrieben danach eine Fehlermeldung zu einem Gerät,
   * das der nächste Nutzer gar nicht kennt — und die Meldung blieb dort stehen,
   * denn gelöscht wird sie erst beim nächsten Klick auf dasselbe Gerät.
   */
  reset(): void {
    for (const w of this.#wecker.values()) clearTimeout(w);
    this.#wecker.clear();
    for (const ab of this.#fehlerWacht.values()) ab();
    this.#fehlerWacht.clear();
    this.#juengster = null;
    this.#vorher.clear();
    this.offen = {};
    this.fehler = {};
  }

  #aufraeumen(k: string): void {
    const w = this.#wecker.get(k);
    if (w) clearTimeout(w);
    this.#wecker.delete(k);
    this.#fehlerWacht.get(k)?.();
    this.#fehlerWacht.delete(k);
    if (this.#juengster === k) this.#juengster = null;
    this.#vorher.delete(k);
    delete this.offen[k];
  }
}

export const schirmWarten = new SchirmWarten();
