import { huelleKennt } from './huelleKann';
import { abmelder, type HoererGriff } from './hoererAbmelden';
import { isCapacitorIOS } from './runtime';

/**
 * iOS-Audio-Session-Steuerung (Hülle) — natives Gegenstück zu
 * `setVoiceActive` auf Android (audioRoute.ts).
 *
 * WARUM: iOS killt die Audio-Session beim Sperren des Displays, und der
 * `voiceChat`-Modus (iOS-eigenes Echo-Auslösen + Bluetooth-Mikrofon) wird
 * vom Browser-Stack nicht gesetzt. Das native Plugin (App/AudioSession-
 * Plugin.swift, im App-Target auto-registriert) steuert die Prozess-Session.
 *
 * Browser und Electron: No-op.
 */

/** Ein waehlbarer Ausgabeweg. `id` ist `speaker`, `earpiece` oder die UID
 *  eines echten Geraets (AirPods, Autoradio, Kabel-Headset). */
export interface TonWeg {
  id: string;
  /** iOS-Porttyp (`BluetoothHFP`, `HeadphonesBT`, `Speaker`, …) bzw. die
   *  beiden festen Werte `speaker`/`earpiece`. */
  art: string;
  name: string;
}

export interface TonWege {
  /** Porttyp des AKTIVEN Ausgangs — nicht zwingend eine `id` aus `geraete`. */
  aktuell: string;
  aktuellName: string;
  geraete: TonWeg[];
}

/**
 * Ein gemeldeter Wechsel des Ausgabewegs.
 *
 * `weg` ist die Einteilung der Huelle (`eingebaut`/`kabel`/`funk`) — und der
 * einzige Teil, an dem haengt, ob die Session neu eingerichtet werden muss.
 * `aktuell` ist der genaue Porttyp und nur fuer die Anzeige gedacht: ein
 * Wechsel von Lautsprecher auf Hoermuschel aendert ihn, den Tonweg nicht.
 */
export interface WegWechsel {
  aktuell: string;
  aktuellName: string;
  weg: string;
}

/** Telefonanruf, Siri, Wecker. */
export interface Unterbrechung {
  art: 'begonnen' | 'beendet';
  /** Nur bei `beendet`: iOS haelt ein Fortsetzen fuer angebracht. */
  weiterMoeglich?: boolean;
}

interface AudioSessionPlugin {
  setVoiceActive(
    options: { aktiv: boolean; hqFunk: boolean }
  ): Promise<{ modus: string; weg: string }>;
  setPlaybackMode(): Promise<void>;
  routen(): Promise<TonWege>;
  jetztLaeuft(options: { titel: string; zeile2: string }): Promise<void>;
  jetztLaeuftAus(): Promise<void>;
  airplayWaehler(): Promise<void>;
  // **Kein Promise:** am rohen Objekt (s. `plugin` unten) kommt der Griff
  // sofort — Begründung und Fundstellen in `hoererAbmelden.ts`. Und darum
  // fehlt `addListener` in `pluginMethods` von `AudioSessionPlugin.swift` mit
  // Recht: dort eingetragen, ersetzte `JSExport` diesen Weg am rohen Objekt
  // durch einen, der den Ereignisnamen unbenannt schickt — der Absturz, den
  // `iosSprache.ts` an `const nativ` beschreibt.
  addListener(name: 'unterbrechung', cb: (e: Unterbrechung) => void): HoererGriff;
  addListener(name: 'routeGewechselt', cb: (e: WegWechsel) => void): HoererGriff;
  addListener(name: 'fernbefehl', cb: (e: { befehl: 'laut' | 'stumm' }) => void): HoererGriff;
}

/**
 * Das Plugin — aber nur in der iOS-Hülle und nur, wenn der installierte Bau
 * `methode` kennt. Ausserhalb der Hülle (Browser, Electron, Android) ist die
 * Antwort immer `null`, und jede Funktion hier fällt auf ihre Rückfall-Antwort.
 *
 * **Das rohe `Capacitor.Plugins`-Objekt hat genau die Methoden SEINES Baus.**
 * Vier kamen erst zwei Tage nach dem Plugin (`routen`, `jetztLaeuft`,
 * `jetztLaeuftAus`, `airplayWaehler`, alle 2026-10-08; das Plugin selbst
 * 2026-10-06; `routeSetzen` ist hier nicht mehr eingebunden). Auf einem Bau dazwischen sind sie `undefined`,
 * und ihr Aufruf wäre ein `TypeError` statt der Rückfall-Antwort, die jede
 * Funktion hier verspricht (`null`, `false`, nichts). Hängen kann dabei
 * nichts (`huelleKann.ts`); gefragt wird trotzdem an derselben Stelle wie
 * überall.
 */
function plugin(methode: keyof AudioSessionPlugin): AudioSessionPlugin | null {
  if (typeof window === 'undefined' || !isCapacitorIOS()) return null;
  const cap = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  const p = cap?.Plugins?.AudioSessionPlugin as AudioSessionPlugin | undefined;
  return p && huelleKennt('AudioSessionPlugin', methode) ? p : null;
}

/**
 * Voice-Modus an/aus. Liefert den Modus, den die Hülle gewählt hat.
 *
 * Heute nur noch für den Web-Anruf der Hülle (`anrufe/webAnrufRaum.ts`, Bauten
 * ohne nativen Anruf-Raum): der Sprachkanal läuft nativ, und die Hülle wählt
 * dort Modus und Bluetooth-HQ selbst. Die Bluetooth-HQ-Route des früheren
 * Web-Sprachwegs (`hqFunk`) wird deshalb nicht mehr angefordert.
 *
 * `modus` ist `unbekannt`, wenn die Hülle ihn nicht nennt (älterer Bau).
 *
 * `ok`: hat die Hülle eingerichtet? Ohne das merkte sich `iosTon` eine
 * Betriebsart, die nie angewandt war, und versuchte sie nie wieder
 * (Bughunt 2026-10-11, G2).
 */
export async function iosVoiceAktiv(
  aktiv: boolean
): Promise<{ modus: string; weg: string | null; ok: boolean }> {
  const p = plugin('setVoiceActive');
  if (!p) return { modus: 'unbekannt', weg: null, ok: false };
  const antwort = await p.setVoiceActive({ aktiv, hqFunk: false }).catch((e: unknown) => {
    // **Nicht stillschweigend verschlucken.** Scheitert das Einrichten, ist
    // die Session nicht aktiv — der Sprachkanal steht dann verbunden da und
    // ist stumm. Am 2026-10-10 am Geraet gesehen; der Fehlschlag war in der
    // Oberflaeche an nichts erkennbar. Der Rueckfall bleibt derselbe, aber er
    // ist jetzt sichtbar.
    console.error('[Ton] setVoiceActive fehlgeschlagen', e);
    return undefined;
  });
  // `weg: null` heisst „nicht erfahren", nicht „kein Weg" — der Aufrufer darf
  // daraus keinen Wegwechsel ableiten.
  return {
    modus: antwort?.modus ?? 'unbekannt',
    weg: antwort?.weg ?? null,
    ok: antwort !== undefined
  };
}

/** Playback-Modus (Watch-/Stream-Ton ohne Mikro). `false` = nicht
 *  eingerichtet (s. `ok` an `iosVoiceAktiv`). */
export async function iosPlaybackModus(): Promise<boolean> {
  const p = plugin('setPlaybackMode');
  if (!p) return false;
  return p
    .setPlaybackMode()
    .then(() => true)
    .catch((e: unknown) => {
      console.error('[Ton] setPlaybackMode fehlgeschlagen', e);
      return false;
    });
}

/**
 * Die verfuegbaren Ausgabewege. Leere Liste ausserhalb der Huelle.
 *
 * **iOS waehlt anders als Android**: dort pinnt man ein Ausgabegeraet, hier
 * waehlt man den Eingang und der Ausgang folgt (bei einem Bluetooth-Headset
 * ist beides dasselbe Geraet). Lautsprecher und Hoermuschel sind kein
 * Eingang, sondern eine Uebersteuerung — sie stehen deshalb als feste
 * Eintraege in der Liste.
 */
export async function iosTonWege(): Promise<TonWege | null> {
  const p = plugin('routen');
  if (!p) return null;
  return p.routen().catch(() => null);
}

// **Unterbrechungen (Telefonanruf, Siri, Wecker) hören wir hier bewusst nicht
// ab** (Entscheid 2026-10-10; der Binder `iosUnterbrechungen` ist entfernt,
// er hatte keinen Aufrufer mehr): wer auf eine beendete Unterbrechung hin die
// eigene Session wieder aktiviert, unterbricht damit WebKit und räumt dessen
// laufende Aufnahme ab. Die Hülle meldet weiter und schreibt es ins
// Gerätelog; wer hier wieder zuhört, braucht vorher eine Messung, dass
// überhaupt etwas kaputtgeht. Das Plugin-Ereignis `unterbrechung` bleibt in
// `AudioSessionPlugin` (`addListener` unten) deklariert.

/** Wegwechsel melden (Headset rein/raus, AirPods verbunden). */
export function iosWegWechsel(cb: (e: WegWechsel) => void): () => void {
  const p = plugin('addListener');
  if (!p) return () => undefined;
  // **Die Nutzlast wird durchgereicht, nicht verworfen.** Sie war von Anfang
  // an da (`routeGewechselt` in `AudioSessionPlugin.swift`); dass dieser
  // Binder sie wegwarf, hat `iosTon.ts` monatelang zu einer Zeitfrist
  // gezwungen, wo ein Vergleich genuegt.
  return abmelder(p.addListener('routeGewechselt', cb));
}

/** Was gerade läuft, auf Sperrbildschirm und Kontrollzentrum anzeigen. */
export async function iosJetztLaeuft(titel: string, zeile2: string): Promise<void> {
  await plugin('jetztLaeuft')?.jetztLaeuft({ titel, zeile2 }).catch(() => undefined);
}

/** Anzeige wieder abräumen. */
export async function iosJetztLaeuftAus(): Promise<void> {
  await plugin('jetztLaeuftAus')?.jetztLaeuftAus().catch(() => undefined);
}

/** Knopfdrücke vom Sperrbildschirm (`laut`/`stumm`). Rückgabe = Abriss. */
export function iosFernbefehle(cb: (befehl: 'laut' | 'stumm') => void): () => void {
  const p = plugin('addListener');
  if (!p) return () => undefined;
  return abmelder(p.addListener('fernbefehl', (e) => cb(e.befehl)));
}

/**
 * Öffnet Apples AirPlay-Auswahl (Punkt 30 der iOS-Liste).
 *
 * Gibt `false` zurück, wenn der Dialog nicht aufgeht — dann gehört ein
 * Hinweis auf das Kontrollzentrum in die Oberfläche. Das Plugin kann das
 * nicht garantieren (Begründung dort an der Methode), und ein Knopf, der
 * still nichts tut, wäre die schlechtere Antwort.
 */
export async function iosAirplayWaehler(): Promise<boolean> {
  const p = plugin('airplayWaehler');
  if (!p) return false;
  return p
    .airplayWaehler()
    .then(() => true)
    .catch((e) => {
      console.warn('[iosAudioSession] AirPlay-Auswahl nicht erreichbar', e);
      return false;
    });
}
