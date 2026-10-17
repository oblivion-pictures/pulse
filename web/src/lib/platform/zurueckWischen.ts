/**
 * Zurück per Wischen vom linken Rand — das Gegenstück der iOS-Hülle zur
 * Android-Zurück-Taste (`zurueckTaste.ts`), mit derselben Eltern-Tabelle
 * (`navigation/elternRoute.ts`). iOS hat keine System-Zurück-Taste; die Pfeile
 * in den Köpfen sind der einzige Weg, und die Randgeste ist, was man dort
 * erwartet.
 *
 * **Kein Rückfall auf die Browser-Historie.** Anders als Android fällt die
 * Geste bei einem Bildschirm ohne bekannten Elter (Bereichs-Wurzeln) einfach
 * weg: eine Wischgeste, die ins Leere oder vor den App-Einstieg springt, ist
 * schlimmer als keine.
 *
 * **Die WKWebView hat ihre eigene Zurück-Geste NICHT an**
 * (`allowsBackForwardNavigationGestures` ist weder in unserem Bau noch in
 * Capacitors `CAPBridgeViewController` gesetzt, Vorgabe `false`) — die beiden
 * kommen sich nicht ins Gehege. **Wer das Flag je setzt, bekommt zwei Gesten
 * auf demselben Rand.**
 *
 * Touch-Ereignisse statt Pointer-Ereignisse: bei einem Pointer-Strom bricht
 * WebKit mit `pointercancel` ab, sobald es die Berührung als Pan übernimmt,
 * und der Beginn einer waagrechten Geste am Rand ließe sich nicht verlässlich
 * halten. `touchmove` ist nicht passiv, damit die Seite dahinter während der
 * Geste nicht mitschiebt (wie `mobile/blattAktionen.ts`).
 *
 * Nicht, wenn etwas anderes die Berührung braucht: ein offener Dialog oder ein
 * Blatt, ein Video, ein Schieber, eine waagrecht scrollbare Fläche.
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { elterVon } from '$lib/navigation/elternRoute';
import { anDerKante, ausgeloest, verlauf } from '$lib/navigation/kantenWischen';
import { isCapacitorIOS } from './runtime';

let registriert = false;

/** Etwas, das Berührungen am Rand selbst braucht (Schieber, Video, Eingabe). */
const EIGENE_BEDIENUNG = 'video, audio, input[type="range"], textarea, [data-edge-swipe-aus]';
/** Offene Dialoge, Alert-Dialoge und Blätter (`BottomSheet` ist `role="dialog"`). */
const OFFENE_DECKE = '[role="dialog"], [role="alertdialog"]';

function scrollbarWaagrecht(el: Element | null): boolean {
  for (let k = el; k && k !== document.documentElement; k = k.parentElement) {
    if (!(k instanceof HTMLElement) || k.scrollWidth <= k.clientWidth + 1) continue;
    const ox = getComputedStyle(k).overflowX;
    if (ox === 'auto' || ox === 'scroll') return true;
  }
  return false;
}

function darfStarten(ziel: EventTarget | null): boolean {
  if (elterVon(page.url.pathname) === null) return false;
  if (document.querySelector(OFFENE_DECKE)) return false;
  const el = ziel instanceof Element ? ziel : null;
  if (el?.closest(EIGENE_BEDIENUNG)) return false;
  return !scrollbarWaagrecht(el);
}

/** Einmalig registrieren (idempotent). Nur in der iOS-Hülle aktiv. */
export function registriereZurueckWischen(): void {
  if (registriert || !isCapacitorIOS()) return;
  registriert = true;

  let start: { x: number; y: number; id: number } | null = null;
  let entschieden = false;

  document.addEventListener(
    'touchstart',
    (e) => {
      start = null;
      entschieden = false;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!anDerKante(t.clientX) || !darfStarten(e.target)) return;
      start = { x: t.clientX, y: t.clientY, id: t.identifier };
    },
    { passive: true }
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!start) return;
      const t = Array.from(e.touches).find((x) => x.identifier === start!.id);
      if (!t) return;
      const v = verlauf(t.clientX - start.x, t.clientY - start.y);
      if (v === 'abgebrochen') {
        start = null;
        return;
      }
      if (v === 'waagrecht') {
        entschieden = true;
        // Die Seite dahinter soll nicht mitscrollen oder federn.
        if (e.cancelable) e.preventDefault();
      }
    },
    { passive: false }
  );

  document.addEventListener(
    'touchend',
    (e) => {
      const s = start;
      start = null;
      if (!s || !entschieden) return;
      const t = Array.from(e.changedTouches).find((x) => x.identifier === s.id);
      if (!t || !ausgeloest(t.clientX - s.x, t.clientY - s.y)) return;
      const elter = elterVon(page.url.pathname);
      if (elter) void goto(elter, { noScroll: true });
    },
    { passive: true }
  );

  document.addEventListener(
    'touchcancel',
    () => {
      start = null;
    },
    { passive: true }
  );
}
