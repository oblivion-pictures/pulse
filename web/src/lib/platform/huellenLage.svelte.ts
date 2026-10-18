/**
 * Lage der iOS-Hülle, die das Layout braucht und CSS allein nicht weiss:
 * steht das Telefon quer, ist die Tastatur offen. **Nur in der iOS-Hülle** —
 * Browser, Electron und Android bleiben bei `quer = false` und ohne Marke am
 * <html> (Eigentümer-Grundsatz 2026-10-16: Android wie vor der iOS-Arbeit).
 *
 * Tastatur: die Hülle fährt `Keyboard.resize = native` — die WebView schrumpft
 * mit, `--safe-bottom` (Home-Balken) liegt dann aber nicht mehr unter dem
 * Eingabefeld. Während die Tastatur offen ist, steht `data-tastatur="offen"`
 * am <html>, und `app.css` setzt `--safe-bottom` auf 0: sonst stünde über der
 * Tastatur Leerraum für einen Home-Balken, der dort nicht ist. Die Ereignisse
 * des Plugins (`keyboardWillShow/Hide`) kommen vor der Animation, nicht erst
 * danach — der Leerraum springt nicht verspätet weg.
 *
 * Quer: dieselbe Rechnung wie die Querformat-Vollbild-Wache der HQ-Kachel
 * (`stream/querVollbild.ts` → `istQuer`), damit beide nie verschiedener
 * Meinung sind.
 */
import { Keyboard } from '@capacitor/keyboard';
import { jetztQuer } from '$lib/stream/querVollbildWache';
import { isCapacitorIOS } from './runtime';

class HuellenLage {
  quer = $state(false);
  tastaturOffen = $state(false);

  /** Beobachten starten. Rückgabe baut ab. Außerhalb der iOS-Hülle ein No-op. */
  starten(): () => void {
    if (!isCapacitorIOS() || typeof window === 'undefined') return () => undefined;
    const wurzel = document.documentElement;
    const querLesen = () => (this.quer = jetztQuer());
    querLesen();
    const fenster = window.matchMedia('(orientation: landscape)');
    window.addEventListener('resize', querLesen);
    fenster.addEventListener('change', querLesen);
    screen.orientation?.addEventListener('change', querLesen);

    const tastatur = (offen: boolean) => {
      this.tastaturOffen = offen;
      if (offen) wurzel.dataset.tastatur = 'offen';
      else delete wurzel.dataset.tastatur;
    };
    const handles = [
      Keyboard.addListener('keyboardWillShow', () => tastatur(true)),
      Keyboard.addListener('keyboardWillHide', () => tastatur(false))
    ].map((h) => h.catch(() => undefined));
    // Sicherheitsnetz: `keyboardWillHide` kommt nicht immer (App im Hintergrund
    // während die Tastatur steht, Feld verliert den Fokus ohne neues Feld) —
    // sonst bliebe `--safe-bottom` bei 0 und der Home-Balken verdeckte die
    // untere Leiste.
    const versteckt = () => {
      if (document.visibilityState === 'hidden') tastatur(false);
    };
    const fokusWeg = () => {
      setTimeout(() => {
        const fokus = document.activeElement as HTMLElement | null;
        const eingabe =
          fokus && (fokus.matches('input, textarea, select') || fokus.isContentEditable);
        if (!eingabe) tastatur(false);
      }, 0);
    };
    document.addEventListener('visibilitychange', versteckt);
    document.addEventListener('focusout', fokusWeg);
    return () => {
      document.removeEventListener('visibilitychange', versteckt);
      document.removeEventListener('focusout', fokusWeg);
      window.removeEventListener('resize', querLesen);
      fenster.removeEventListener('change', querLesen);
      screen.orientation?.removeEventListener('change', querLesen);
      for (const h of handles) void h.then((x) => x?.remove());
      tastatur(false);
    };
  }
}

export const huellenLage = new HuellenLage();
