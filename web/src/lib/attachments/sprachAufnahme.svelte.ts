/**
 * Sprachnachricht im Verfasser (P0.3, UI 2026-09-11 überarbeitet): TIPPEN
 * statt halten. Ein Tap auf das Mikrofon startet; die Aufnahme-Leiste über dem
 * Eingabekasten bietet „Fertig" und „Verwerfen" (✕ rechts). Keine Halte-Geste
 * mehr: Der Layout-Shift- und Pointercancel-Zirkus aus der ersten Fassung
 * entfiel mit ihr (Testrunde 2026-09-11).
 *
 * Hier stehen Zustand und Sekunden-Ticker der laufenden Aufnahme. Die fertige
 * Datei geht an `onDatei` — im Verfasser derselbe Anhang-Weg wie eine
 * gewählte Datei.
 */
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { aufnahmeGesperrt } from '$lib/platform/aufnahmeSperre';
import { istAblehnung } from '$lib/platform/berechtigung.svelte';
import { isCapacitorIOS } from '$lib/platform/runtime';
import {
  beendeAufnahme,
  brichAufnahmeAb,
  starteAufnahme,
  type LaufendeAufnahme
} from './aufnahme';
import { AUFGABE_MAX_SEKUNDEN, formatiereDauer } from './aufnahmeKern';

export class SprachAufnahme {
  lauf: LaufendeAufnahme | undefined = $state();
  sekunden = $state(0);
  dauer = $derived(formatiereDauer(this.sekunden));
  #timer: ReturnType<typeof setInterval> | undefined;
  #onDatei: (datei: File) => void;

  constructor(onDatei: (datei: File) => void) {
    this.#onDatei = onDatei;
  }

  #tickerStarten(): void {
    this.sekunden = 0;
    this.#timer = setInterval(() => {
      if (!this.lauf) return;
      this.sekunden = Math.floor((Date.now() - this.lauf.gestartetAm) / 1000);
      // Der 300-s-Rahmen endet hier, im UI sichtbar als fertiger Entwurf.
      if (this.sekunden >= AUFGABE_MAX_SEKUNDEN) void this.beenden();
    }, 500);
  }

  async starten(): Promise<void> {
    if (this.lauf) return;
    // iOS-Hülle: im Sprachkanal gehört das Mikrofon der Hülle.
    if (aufnahmeGesperrt('ton')) {
      toast.info(m.aufnahme_im_sprachkanal_gesperrt());
      return;
    }
    try {
      this.lauf = await starteAufnahme();
    } catch (e) {
      // iOS: eine abgelehnte Erlaubnis lässt sich nur in den Einstellungen
      // umkehren — den Weg nennen statt nur „nicht verfügbar".
      if (isCapacitorIOS() && istAblehnung(e)) {
        toast.error(m.mikrofon_abgelehnt_ios(), {
          action: {
            label: m.settings_mitteilungen_huelle_einstellungen(),
            onClick: () => (window.location.href = 'app-settings:')
          }
        });
        return;
      }
      toast.error(m.message_input_mikrofon_fehler());
      return;
    }
    this.#tickerStarten();
  }

  async beenden(): Promise<void> {
    const lauf = this.lauf;
    if (!lauf) return;
    this.lauf = undefined;
    clearInterval(this.#timer);
    const datei = await beendeAufnahme(lauf);
    if (datei) this.#onDatei(datei);
  }

  verwerfen(): void {
    const lauf = this.lauf;
    if (!lauf) return;
    this.lauf = undefined;
    clearInterval(this.#timer);
    brichAufnahmeAb(lauf);
  }
}
