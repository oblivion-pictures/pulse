/**
 * i18n-Helfer rund um die von Paraglide generierte Runtime.
 *
 * Sprachregel (vom Product Owner): Deutsch nur, wenn die Browser-/Systemsprache
 * Deutsch ist — sonst Englisch. Eine manuelle Wahl (Umschalter in den
 * Einstellungen) hat Vorrang und wird in localStorage gehalten.
 *
 * baseLocale ist `de` (die Quelltexte sind Deutsch). Paraglides Default-Fallback
 * wäre damit `de`, was exotische Sprachen fälschlich auf Deutsch setzen würde —
 * deshalb erzwingt initLocale() die „de sonst en"-Regel explizit.
 *
 * **Ausnahme iOS-Hülle** (Eigentümer-Entscheid 2026-10-18): dort gibt es keinen
 * Umschalter, die App folgt der Sprache des Geräts. Ein früher gespeicherter
 * `PARAGLIDE_LOCALE` gewinnt dort NICHT mehr — weicht er von der Systemsprache
 * ab, wird sie gesetzt und die Seite einmal neu geladen (Module, die Texte beim
 * Import auswerten, hätten sonst noch die alte Sprache).
 */
import {
  getLocale,
  setLocale,
  isLocale,
  locales,
  type Locale,
} from '$lib/paraglide/runtime';
import { isCapacitorIOS } from '$lib/platform/runtime';

// Paraglides localStorage-Strategie nutzt diesen Key (s. vite.config.ts).
const STORAGE_KEY = 'PARAGLIDE_LOCALE';
const RELOAD_KEY = 'pulse.sprache.neugeladen';

/** Früh beim Client-Start aufrufen (ssr=false). Setzt die Sprache nach der
 *  „de sonst en"-Regel, sofern keine manuelle Wahl gespeichert ist. */
export function initLocale(): void {
  if (typeof window === 'undefined') return;
  const huelle = isCapacitorIOS();
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!huelle && stored && isLocale(stored)) return; // manuelle Wahl gewinnt
  const nav = navigator.language?.toLowerCase() ?? '';
  const desired: Locale = nav.startsWith('de') ? 'de' : 'en';
  if (getLocale() === desired) return;
  setLocale(desired, { reload: huelle && einmalNeuLaden() });
}

/** Erlaubt höchstens einen Neustart je Sitzung — fällt das Schreiben der
 *  Sprache aus (kein Speicher), gäbe es sonst eine Endlosschleife. */
function einmalNeuLaden(): boolean {
  try {
    if (window.sessionStorage.getItem(RELOAD_KEY)) return false;
    window.sessionStorage.setItem(RELOAD_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** Aktuelle Sprache. */
export function currentLocale(): Locale {
  return getLocale();
}

/** Manueller Sprachwechsel (Umschalter). Lädt die Seite neu, damit alle Texte
 *  sicher neu gerendert werden (Paraglide-Default reload:true). */
export function changeLocale(locale: Locale): void {
  setLocale(locale);
}

/** Verfügbare Sprachen — für den Umschalter. */
export const availableLocales = locales;

/** Anzeigenamen der Sprachen für die UI. */
export const localeLabels: Record<Locale, string> = {
  de: 'Deutsch',
  en: 'English',
};
