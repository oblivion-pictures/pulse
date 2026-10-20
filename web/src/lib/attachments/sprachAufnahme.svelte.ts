/**
 * Sprachnachricht im Verfasser (P0.3; UI 2026-09-11 auf Tippen umgestellt,
 * 2026-10-20 um Pause und Vorhören erweitert). Ein Tipp auf das Mikrofon
 * startet; die Leiste IM Eingabekasten (`SprachnachrichtLeiste.svelte`)
 * bietet Verwerfen, Pause/Weiter und Stopp. Stopp führt in die VORSCHAU:
 * anhören, verwerfen oder senden. Erst „Senden" gibt die Datei heraus
 * (`vorschauNehmen`), und der Verfasser schickt sie durch denselben
 * Anhang-Weg wie eine gewählte Datei.
 *
 * Hier stehen Zustand, Sekunden-Ticker und die Vorschau-Datei samt
 * Objekt-URL; das Abspielen selbst gehört der Leiste.
 */
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { aufnahmeGesperrt } from '$lib/platform/aufnahmeSperre';
import { istAblehnung } from '$lib/platform/berechtigung.svelte';
import { isCapacitorIOS } from '$lib/platform/runtime';
import {
  beendeAufnahme,
  brichAufnahmeAb,
  pausiereAufnahme,
  setzeAufnahmeFort,
  starteAufnahme,
  type LaufendeAufnahme
} from './aufnahme';
import { AUFGABE_MAX_SEKUNDEN, formatiereDauer } from './aufnahmeKern';

/** Eine beendete Aufnahme, die auf „Senden" oder „Verwerfen" wartet. */
export interface SprachVorschau {
  datei: File;
  /** Objekt-URL zum Anhören — `vorschauNehmen`/`verwerfen` geben sie frei. */
  url: string;
  sekunden: number;
}

export class SprachAufnahme {
  lauf: LaufendeAufnahme | undefined = $state();
  sekunden = $state(0);
  dauer = $derived(formatiereDauer(this.sekunden));
  /** Pausiert: der Recorder sammelt nicht, die Sekunden stehen. */
  pausiert = $state(false);
  vorschau: SprachVorschau | null = $state(null);
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Zählt Verwerfen-Aufrufe: ein Stopp, dessen Datei erst nach einem
   *  Verwerfen fertig wird (Gesprächswechsel), legt keine Vorschau mehr an. */
  #verworfen = 0;

  #tickerStarten(): void {
    this.#timer = setInterval(() => {
      if (!this.lauf) return;
      // `gestartetAm` ist um die Pausen verschoben (`setzeAufnahmeFort`),
      // deshalb zählt diese Differenz nur die aufgenommene Zeit.
      this.sekunden = Math.floor((Date.now() - this.lauf.gestartetAm) / 1000);
      // Der 300-s-Rahmen endet hier, im UI sichtbar als fertige Vorschau.
      if (this.sekunden >= AUFGABE_MAX_SEKUNDEN) void this.zurVorschau();
    }, 500);
  }

  #tickerStoppen(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Nimmt die laufende Aufnahme aus dem Zustand — gemeinsamer Anfang von
   *  Stopp und Verwerfen. */
  #laufLoesen(): LaufendeAufnahme | undefined {
    const lauf = this.lauf;
    this.lauf = undefined;
    this.pausiert = false;
    this.#tickerStoppen();
    return lauf;
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
    this.sekunden = 0;
    this.#tickerStarten();
  }

  pausieren(): void {
    if (!this.lauf || this.pausiert) return;
    pausiereAufnahme(this.lauf);
    this.#tickerStoppen();
    this.pausiert = true;
  }

  weiter(): void {
    if (!this.lauf || !this.pausiert) return;
    setzeAufnahmeFort(this.lauf);
    this.#tickerStarten();
    this.pausiert = false;
  }

  /** Stopp: die Aufnahme endet und wartet als Vorschau auf Freigabe. Eine zu
   *  kurze Aufnahme (`beendeAufnahme` → null) verschwindet still, wie vorher
   *  beim sofortigen Loslassen. */
  async zurVorschau(): Promise<void> {
    const lauf = this.#laufLoesen();
    if (!lauf) return;
    const sekunden = this.sekunden;
    const stand = this.#verworfen;
    const datei = await beendeAufnahme(lauf);
    if (!datei || stand !== this.#verworfen) return;
    this.#vorschauLeeren();
    this.vorschau = { datei, url: URL.createObjectURL(datei), sekunden };
  }

  /** „Senden": gibt die Datei heraus und räumt die Vorschau ab. */
  vorschauNehmen(): File | null {
    const datei = this.vorschau?.datei ?? null;
    this.#vorschauLeeren();
    return datei;
  }

  /** Verwirft, was gerade da ist — laufende Aufnahme UND Vorschau. Auch der
   *  Aufräumweg beim Gesprächswechsel: eine Aufnahme aus Gespräch A darf
   *  nicht in Gespräch B landen. */
  verwerfen(): void {
    this.#verworfen++;
    const lauf = this.#laufLoesen();
    if (lauf) brichAufnahmeAb(lauf);
    this.#vorschauLeeren();
  }

  #vorschauLeeren(): void {
    if (this.vorschau) URL.revokeObjectURL(this.vorschau.url);
    this.vorschau = null;
  }
}
