/**
 * Svelte-Übergänge des Blattes von unten (`BottomSheet.svelte`): das Blatt
 * schiebt sich mit der Feder von unten herein, die Abdunkelung blendet ein.
 * Nur `transform`/`opacity` — beides kann der Compositor ohne Layout abspielen.
 *
 * Keine Runen hier (`.ts`).
 */
import { federKurve } from './feder';

export const DAUER_AUF = 320;
export const DAUER_ZU = 260;
/** Kurze Überblendung statt Bewegung bei „Bewegung reduzieren“. */
export const DAUER_REDUZIERT = 120;

function bewegungReduziert(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Optionen {
  direction: 'in' | 'out' | 'both';
}

/** Das Blatt: `translateY(100%) → 0`, beim Schliessen umgekehrt. */
export function blattFahrt(node: Element, _p: unknown, o: Optionen) {
  if (bewegungReduziert()) return { duration: DAUER_REDUZIERT, css: (t: number) => `opacity:${t}` };
  // Hat der Wisch das Blatt schon aus dem Bild gezogen (`blattAktionen.wischen`
  // setzt dann `transform`), gäbe es sonst ein zweites Mal Bewegung: nach oben
  // springen und erneut hinunter. Dann nur noch ausblenden lassen, was bleibt.
  if (o.direction === 'out' && node instanceof HTMLElement && node.style.transform) {
    return { duration: 0 };
  }
  return {
    duration: o.direction === 'out' ? DAUER_ZU : DAUER_AUF,
    easing: federKurve,
    css: (_t: number, u: number) => `transform:translateY(${u * 100}%)`
  };
}

/** Die Abdunkelung: Deckkraft `0 → 1`, beim Schliessen umgekehrt. */
export function abdunkelung(_node: Element, _p: unknown, o: Optionen) {
  const css = (t: number): string => `opacity:${t}`;
  if (bewegungReduziert()) return { duration: DAUER_REDUZIERT, css };
  return { duration: o.direction === 'out' ? DAUER_ZU : DAUER_AUF, easing: federKurve, css };
}
