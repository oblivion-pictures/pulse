/**
 * Netzwache — holt die WebSocket-Verbindungen zurück, sobald es einen Anlass
 * gibt, statt auf die nächste Backoff-Stufe zu warten.
 *
 * **Das Problem, das sie löst, ist ein Mobil-Problem.** Der Reconnect staffelt
 * sich bis 300 s auseinander, und das ist gegen einen abweisenden Server
 * richtig. Auf einem Telefon ist es die falsche Zahl: Tunnel, Flugmodus,
 * WLAN→Mobilfunk, Bildschirm zehn Minuten aus — danach stand die App bis zu
 * fünf Minuten still, ohne dass irgendetwas kaputt war. Was fehlte, war nicht
 * ein kürzerer Takt, sondern der ANLASS.
 *
 * Drei Anlässe, und alle drei braucht es:
 *   - `online` — das Netz meldet sich zurück. Sagt nichts darüber, ob es
 *     TRÄGT (ein Hotelnetz mit Anmeldeseite ist „online"), deshalb ist es ein
 *     Anlass und kein Beweis.
 *   - `visibilitychange` → sichtbar. Deckt den Browser und jeden Tab ab; in
 *     einer Hülle feuert es beim Zurückholen der App mit.
 *   - Capacitor `appStateChange` → `isActive`. **Nicht überflüssig neben dem
 *     zweiten:** iOS friert eine App im Hintergrund ein, und ob die WebView
 *     beim Auftauen zuverlässig `visibilitychange` nachliefert, ist nicht
 *     belegt — gemessen habe ich es nicht. Der Zusatz kostet einen Haken, und
 *     zwei Anlässe gleichzeitig verpuffen ohnehin (Mindestabstand in
 *     `wachentscheid.ts`).
 *
 * Die eigentliche Entscheidung („verbinden, pingen oder nichts") steht geprüft
 * in `wachentscheid.ts`; hier stehen nur die Anlässe.
 */
import { App as CapApp } from '@capacitor/app';
import { isCapacitorAndroid, isCapacitorIOS } from '$lib/platform/runtime';
import { gatewayPool } from './gateway-pool.svelte';
import { hintergrundTrennung } from './wachentscheid';

let laeuft = false;

/** Einmal pro Fenster aufrufen (`app/+layout.svelte`). Mehrfachaufrufe sind
 *  wirkungslos — die Haken hängen am Fenster, nicht an einer Komponente, und
 *  würden sich sonst stapeln. */
export function netzwacheStarten(): void {
  if (laeuft || typeof window === 'undefined') return;
  laeuft = true;

  const wecken = () => gatewayPool.alleWachPruefen();
  // Sichtbar/aktiv heisst „vorn“: das hebt zusätzlich eine
  // Hintergrund-Trennung auf. `online` allein nicht — es feuert auch im
  // Hintergrund und verbände dort still neu (der Server schickte dann
  // keinen Push mehr).
  const vorn = () => gatewayPool.alleVordergrund();

  window.addEventListener('online', wecken);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') vorn();
  });

  if (isCapacitorIOS() || isCapacitorAndroid()) {
    // Kein `await`: der Haken darf nachträglich scharf werden, die ersten
    // Millisekunden nach dem Start deckt der normale Verbindungsaufbau ab.
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        vorn();
        for (const haken of vordergrundHaken) haken();
        return;
      }
      for (const haken of hintergrundHaken) haken();
      // Gegenrichtung zum Wecken: Hintergrund ⇒ Verbindungen bewusst lösen,
      // damit der Server die Zustellung auf Push umstellt (Entscheidung in
      // `wachentscheid.hintergrundTrennung`, Mechanik in
      // `GatewayConnection.hintergrundTrennung`). Das Zurückholen läuft über
      // den isActive- bzw. Sichtbar-Anlass (`vorn`) — kein eigener Haken nötig.
      if (hintergrundTrennung(isCapacitorAndroid(), [...trennSperren])) {
        gatewayPool.hintergrundTrennung();
      }
    });
  }
}

/** Sperren gegen die Hintergrund-Trennung — Zustände, deren Signalisierung an
 *  derselben Leitung hängt (laufender Sprachkanal, Anruf). Die Stores melden
 *  sich hier an (`+layout.svelte` verdrahtet), weil netzwache sie nicht
 *  importieren darf: über `gateway-pool` stünde das in einem Import-Kreis. */
const trennSperren = new Set<() => boolean>();

/** Eine Sperre anmelden; Rückgabe meldet sie wieder ab. */
export function hintergrundTrennSperre(sperre: () => boolean): () => void {
  trennSperren.add(sperre);
  return () => trennSperren.delete(sperre);
}

/** Haken für „App ist in den Hintergrund“ bzw. „wieder vorn“ — gefeuert in
 *  dieser Reihenfolge VOR der Hintergrund-Trennung. Die Haken dürfen selbst
 *  importieren, was sie brauchen; hier liegen nur die Anlässe. Genau dasselbe
 *  Muster wie `hintergrundTrennSperre`: die interessierten Module dürfen
 *  netzwache nicht importieren (Kreis über `lib/ws`). */
const hintergrundHaken = new Set<() => void>();
const vordergrundHaken = new Set<() => void>();

export function beiHintergrund(haken: () => void): () => void {
  hintergrundHaken.add(haken);
  return () => hintergrundHaken.delete(haken);
}

export function beiVordergrund(haken: () => void): () => void {
  vordergrundHaken.add(haken);
  return () => vordergrundHaken.delete(haken);
}
