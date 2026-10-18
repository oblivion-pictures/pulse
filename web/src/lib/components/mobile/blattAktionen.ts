/**
 * Die zwei DOM-Aktionen des Blattes von unten (`BottomSheet.svelte`): Wegwischen
 * am Kopf und Fokusfalle samt `inert` für den Hintergrund. Als Svelte-Aktionen,
 * weil beides rohe Ereignisse braucht — Svelte 5 hängt `ontouchmove` passiv an,
 * und ein passiver Hörer kann das Scrollen der Seite nicht verhindern.
 *
 * Keine Runen hier (`.ts`, nicht `.svelte.ts`).
 */
import { imKopf, senkrecht, tempo, versatz, weg, WISCH_SCHWELLE, type Probe } from './blattWischen';
import { belegen, freigeben } from './inertZaehler';

const RUECKFEDERN = 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)';
const WEGGLEITEN = 'transform 160ms ease-in';

/** Ausdrückliches Kopf-/Griff-Element: dort darf der Wisch immer starten. */
const KOPF_ELEMENT = '[data-blatt-kopf]';

/**
 * Steht der Inhalt unter dem Finger oben? Alle scrollenden Vorfahren zwischen
 * Ziel und Blatt müssen ganz oben stehen — sonst gehört die Bewegung dem
 * Scrollen, auch wenn der Finger im obersten Streifen des Blattes beginnt.
 */
function inhaltOben(ziel: EventTarget | null, blatt: HTMLElement): boolean {
  if (!(ziel instanceof Element)) return true;
  if (ziel.closest(KOPF_ELEMENT)) return true;
  for (let el: Element | null = ziel; el; el = el.parentElement) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight) {
      const ov = getComputedStyle(el).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && el.scrollTop > 0) return false;
    }
    if (el === blatt) break;
  }
  return true;
}

/**
 * Zieht das Blatt mit dem Finger nach unten, wenn die Berührung im Kopf beginnt;
 * Loslassen: weit oder schnell genug → `onClose`, sonst zurückfedern.
 */
export function wischen(blatt: HTMLElement, params: { onClose: () => void }) {
  let onClose = params.onClose;
  let start: { x: number; y: number; id: number } | null = null;
  let zieht = false;
  let proben: Probe[] = [];

  function setze(dy: number, uebergang: string): void {
    blatt.style.transition = uebergang;
    blatt.style.transform = dy === 0 ? '' : `translateY(${dy}px)`;
  }

  function beiStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!imKopf(t.clientY, blatt.getBoundingClientRect().top)) return;
    if (!inhaltOben(e.target, blatt)) return;
    start = { x: t.clientX, y: t.clientY, id: t.identifier };
    zieht = false;
    proben = [{ y: t.clientY, t: e.timeStamp }];
  }

  function beiBewegung(e: TouchEvent): void {
    if (!start) return;
    const t = Array.from(e.touches).find((x) => x.identifier === start!.id);
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!zieht) {
      if (Math.hypot(dx, dy) < WISCH_SCHWELLE) return;
      if (!senkrecht(dx, dy)) {
        start = null; // waagrecht: gehört dem Inhalt
        return;
      }
      zieht = true;
    }
    // Die Seite dahinter soll nicht mitscrollen, solange das Blatt gezogen wird.
    if (e.cancelable) e.preventDefault();
    proben.push({ y: t.clientY, t: e.timeStamp });
    if (proben.length > 8) proben.shift();
    setze(versatz(dy), 'none');
  }

  function beiEnde(e: TouchEvent): void {
    if (!start) return;
    const t = Array.from(e.changedTouches).find((x) => x.identifier === start!.id);
    const war = zieht;
    const dy = t ? t.clientY - start.y : 0;
    const tempoNachUnten = tempo(proben);
    start = null;
    zieht = false;
    if (!war) return;
    if (e.type !== 'touchcancel' && weg(dy, blatt.offsetHeight, tempoNachUnten)) {
      setze(blatt.offsetHeight, WEGGLEITEN);
      // transitionend kann ausbleiben (Hintergrund, reduzierte Bewegung) — Frist.
      window.setTimeout(() => onClose(), 160);
    } else {
      setze(0, RUECKFEDERN);
    }
  }

  blatt.addEventListener('touchstart', beiStart, { passive: true });
  blatt.addEventListener('touchmove', beiBewegung, { passive: false });
  blatt.addEventListener('touchend', beiEnde, { passive: true });
  blatt.addEventListener('touchcancel', beiEnde, { passive: true });
  return {
    update(neu: { onClose: () => void }) {
      onClose = neu.onClose;
    },
    destroy() {
      blatt.removeEventListener('touchstart', beiStart);
      blatt.removeEventListener('touchmove', beiBewegung);
      blatt.removeEventListener('touchend', beiEnde);
      blatt.removeEventListener('touchcancel', beiEnde);
    }
  };
}

/** Wie viele Fokusfallen halten ein Element gerade `inert`. */
const inertHalter = new Map<HTMLElement, number>();

const sperreAktiv = (): boolean => 'appSperre' in document.documentElement.dataset;

/** `inert` lösen — unter laufender App-Sperre erst, wenn sie weg ist. */
function loesen(k: HTMLElement): void {
  if (!sperreAktiv()) {
    k.inert = false;
    return;
  }
  const wache = new MutationObserver(() => {
    if (sperreAktiv()) return;
    wache.disconnect();
    if (!inertHalter.has(k)) k.inert = false;
  });
  wache.observe(document.documentElement, { attributes: true, attributeFilter: ['data-app-sperre'] });
}

const FOKUSBAR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Für VoiceOver und Tastatur: der Rest der Seite wird `inert` (nur, was beim
 * Öffnen schon da war — ein Dialog, den eine Aktion des Blattes öffnet, bleibt
 * bedienbar), der Fokus zieht ins Blatt, Tab bleibt darin, Escape schliesst,
 * und beim Schliessen kehrt der Fokus zum Auslöser zurück.
 *
 * `wurzel` ist die Portal-Fläche; das Blatt darin trägt `role="dialog"`.
 */
export function fokusFalle(wurzel: HTMLElement, params: { onClose: () => void }) {
  let onClose = params.onClose;
  const vorher = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // Das Portal hängt die Fläche irgendwo unter `body`; ihr oberster Vorfahre ist
  // der Teil, der bedienbar bleiben muss.
  let oben: HTMLElement = wurzel;
  while (oben.parentElement && oben.parentElement !== document.body) oben = oben.parentElement;
  const gesperrt: HTMLElement[] = [];
  // Unter der App-Sperre bleibt alles, wie sie es gesetzt hat: ihre Wache
  // übergeht Elemente, die schon `inert` sind, und ein von uns gelöstes `inert`
  // risse ein Loch in die Sperre.
  if (!sperreAktiv()) {
    for (const k of Array.from(document.body.children)) {
      if (k === oben || !(k instanceof HTMLElement)) continue;
      if (k.tagName === 'SCRIPT' || k.tagName === 'STYLE') continue;
      // Fremdes `inert` (Dialog, Sperre) bleibt fremd; eigenes wird mitgezählt.
      if (k.inert && !inertHalter.has(k)) continue;
      if (belegen(inertHalter, k)) k.inert = true;
      gesperrt.push(k);
    }
  }

  const blatt = wurzel.querySelector<HTMLElement>('[role="dialog"]');
  // Nach dem Aufbau: in das Blatt, nicht auf die Abdunkelung.
  // (Ein Eingabefeld, das beim Aufbau selbst den Fokus nahm, behält ihn.)
  queueMicrotask(() => {
    if (!wurzel.contains(document.activeElement)) blatt?.focus({ preventScroll: true });
  });

  function beiTaste(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !blatt) return;
    const ziele = Array.from(blatt.querySelectorAll<HTMLElement>(FOKUSBAR));
    if (ziele.length === 0) {
      e.preventDefault();
      blatt.focus();
      return;
    }
    const erstes = ziele[0];
    const letztes = ziele[ziele.length - 1];
    const aktiv = document.activeElement;
    if (e.shiftKey && (aktiv === erstes || aktiv === blatt)) {
      e.preventDefault();
      letztes.focus();
    } else if (!e.shiftKey && aktiv === letztes) {
      e.preventDefault();
      erstes.focus();
    }
  }
  wurzel.addEventListener('keydown', beiTaste);

  return {
    update(neu: { onClose: () => void }) {
      onClose = neu.onClose;
    },
    destroy() {
      wurzel.removeEventListener('keydown', beiTaste);
      for (const k of gesperrt) {
        if (freigeben(inertHalter, k)) loesen(k);
      }
      // Nur zurück, wenn der Fokus nicht schon woanders (Dialog) gelandet ist.
      const aktiv = document.activeElement;
      if (vorher?.isConnected && (!aktiv || aktiv === document.body || wurzel.contains(aktiv))) {
        vorher.focus({ preventScroll: true });
      }
    }
  };
}
