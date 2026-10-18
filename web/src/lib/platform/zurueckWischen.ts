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
 * **Die Seite folgt dem Finger.** Verschoben wird die Seitenfläche der
 * App-Hülle (`[data-seitenflaeche]` in `routes/app/+layout.svelte`: der
 * Inhaltsbereich der Route, ohne Tab-Leiste und Voice-Dock) per
 * `translateX` — nur `transform`, kein Layout, geschrieben im
 * `requestAnimationFrame`. Eine echte Elternseite darunter gibt es nicht: sie
 * ist nicht gerendert (die Routen sind Mounts, keine gestapelten Seiten), und
 * sie für eine Geste zusätzlich zu rendern hieße Daten laden, Listen
 * aufbauen und Zustand doppeln. Stattdessen deutet ein Schatten links der
 * gleitenden Seite die Tiefe an (`.wisch-folgt`), dahinter liegt der
 * App-Hintergrund. Ab einem Drittel der Breite oder als Flick gleitet die
 * Seite ganz hinaus (Feder, `FEDER_MS`), dann erst `goto(elter)`; sonst
 * federt sie zurück. Die Elternseite erscheint danach ohne eigene Animation
 * (`markiereZurueck('wischen')`). Bei „Bewegung reduzieren" folgt nichts: die
 * Geste löst wie früher ab 60 px aus, die Elternseite blendet kurz ein.
 *
 * Nicht, wenn etwas anderes die Berührung braucht: ein offener Dialog oder ein
 * Blatt, ein Video, ein Schieber, eine waagrecht scrollbare Fläche.
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { elterVon } from '$lib/navigation/elternRoute';
import {
  anDerKante,
  ausgang,
  ausgeloest,
  FEDER_KURVE,
  FEDER_MS,
  folgeWeg,
  tempoAus,
  verlauf,
  type Probe
} from '$lib/navigation/kantenWischen';
import { markiereZurueck } from '$lib/navigation/richtung';
import { isCapacitorIOS } from './runtime';

let registriert = false;

/** Etwas, das Berührungen am Rand selbst braucht (Schieber, Video, Eingabe). */
const EIGENE_BEDIENUNG =
  'video, audio, input[type="range"], textarea, [role="application"], [data-edge-swipe-aus]';
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

/** Die Seitenfläche, die der Finger mitzieht — fehlt auf dem Tablet (Spalte links). */
const seitenflaeche = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-seitenflaeche]');

const bewegungReduziert = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Verschiebung setzen (`null`: alles zurück auf den Ausgangszustand). */
function schieben(el: HTMLElement, dx: number | null): void {
  if (dx === null) {
    el.style.transform = '';
    el.style.willChange = '';
    el.classList.remove('wisch-folgt');
    return;
  }
  el.style.willChange = 'transform';
  el.classList.add('wisch-folgt');
  el.style.transform = `translate3d(${dx}px,0,0)`;
}

/** Feder von `von` nach `nach` px; endet auch bei Abbruch (kein hängendes Versprechen). */
function gleiten(
  el: HTMLElement,
  von: number,
  nach: number
): { ende: Promise<void>; stopp: () => void } {
  const a = el.animate(
    [{ transform: `translate3d(${von}px,0,0)` }, { transform: `translate3d(${nach}px,0,0)` }],
    { duration: FEDER_MS, easing: FEDER_KURVE, fill: 'forwards' }
  );
  return { ende: a.finished.then(() => undefined, () => undefined), stopp: () => a.cancel() };
}

/** Einmalig registrieren (idempotent). Nur in der iOS-Hülle aktiv. */
export function registriereZurueckWischen(): void {
  if (registriert || !isCapacitorIOS()) return;
  registriert = true;

  let start: { x: number; y: number; id: number } | null = null;
  let entschieden = false;
  /** Die mitgezogene Fläche, solange die Seite dem Finger folgt. */
  let folgt: HTMLElement | null = null;
  let proben: Probe[] = [];
  let letzterDx = 0;
  let rahmen = 0;
  /** Hinausgleiten oder Zurückfedern läuft: keine neue Geste dazwischen. */
  let beschaeftigt = false;

  // `touchmove` ist nicht passiv (preventDefault) und hängt deshalb nur,
  // solange eine Randgeste läuft — ein dauerhafter nicht-passiver Hörer am
  // Dokument bremste jedes Scrollen der App.
  function beiBewegung(e: TouchEvent): void {
    const s = start;
    if (!s) return;
    const t = Array.from(e.touches).find((x) => x.identifier === s.id);
    if (!t) return;
    const dx = t.clientX - s.x;
    const v = verlauf(dx, t.clientY - s.y);
    if (v === 'abgebrochen') {
      abbrechen();
      return;
    }
    if (v !== 'waagrecht') return;
    entschieden = true;
    // Die Seite dahinter soll nicht mitscrollen oder federn.
    if (e.cancelable) e.preventDefault();
    if (!folgt) return;
    letzterDx = folgeWeg(dx, window.innerWidth);
    proben.push({ x: letzterDx, t: e.timeStamp });
    if (proben.length > 12) proben.shift();
    if (!rahmen) {
      rahmen = requestAnimationFrame(() => {
        rahmen = 0;
        if (folgt) schieben(folgt, letzterDx);
      });
    }
  }

  function beiEnde(e: TouchEvent): void {
    const s = start;
    const war = entschieden;
    const el = folgt;
    const tempo = tempoAus(proben);
    const dx = letzterDx;
    const t = s ? Array.from(e.changedTouches).find((x) => x.identifier === s.id) : undefined;
    aufraeumen();
    const elter = elterVon(page.url.pathname);
    if (!s || !war || !t || !elter || e.type === 'touchcancel') {
      if (el && war) void zurueckfedern(el, dx);
      return;
    }
    const endeDx = t.clientX - s.x;
    const endeDy = t.clientY - s.y;
    if (!el) {
      // Reduzierte Bewegung (oder keine Fläche): wie vor dem Fingerfolgen.
      if (ausgeloest(endeDx, endeDy)) {
        markiereZurueck('zurueck');
        void goto(elter, { noScroll: true });
      }
      return;
    }
    if (ausgang(endeDx, endeDy, tempo, window.innerWidth) === 'hinaus') {
      void hinaus(el, dx, elter);
    } else {
      void zurueckfedern(el, dx);
    }
  }

  async function zurueckfedern(el: HTMLElement, von: number): Promise<void> {
    beschaeftigt = true;
    const a = gleiten(el, von, 0);
    await a.ende;
    a.stopp();
    schieben(el, null);
    beschaeftigt = false;
  }

  async function hinaus(el: HTMLElement, von: number, elter: string): Promise<void> {
    beschaeftigt = true;
    const a = gleiten(el, von, window.innerWidth);
    await a.ende;
    // Die Seite steht draußen; die Elternseite kommt ohne eigene Animation.
    markiereZurueck('wischen');
    try {
      await goto(elter, { noScroll: true });
    } finally {
      // Erst nach dem Rendern der Elternseite zurücksetzen, sonst blitzt die
      // alte Seite einen Frame lang auf.
      requestAnimationFrame(() => {
        a.stopp();
        schieben(el, null);
        beschaeftigt = false;
      });
    }
  }

  /** Geste verworfen (senkrecht, nach links): die Seite federt zurück. */
  function abbrechen(): void {
    const el = entschieden ? folgt : null;
    const dx = letzterDx;
    aufraeumen();
    if (el) void zurueckfedern(el, dx);
  }

  /** Hörer und Geste-Zustand weg; die Fläche selbst bleibt dem Aufrufer. */
  function aufraeumen(): void {
    start = null;
    entschieden = false;
    folgt = null;
    proben = [];
    letzterDx = 0;
    if (rahmen) cancelAnimationFrame(rahmen);
    rahmen = 0;
    document.removeEventListener('touchmove', beiBewegung);
    document.removeEventListener('touchend', beiEnde);
    document.removeEventListener('touchcancel', beiEnde);
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      if (beschaeftigt) return;
      aufraeumen();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!anDerKante(t.clientX) || !darfStarten(e.target)) return;
      start = { x: t.clientX, y: t.clientY, id: t.identifier };
      folgt = bewegungReduziert() ? null : seitenflaeche();
      document.addEventListener('touchmove', beiBewegung, { passive: false });
      document.addEventListener('touchend', beiEnde, { passive: true });
      document.addEventListener('touchcancel', beiEnde, { passive: true });
    },
    { passive: true }
  );
}
