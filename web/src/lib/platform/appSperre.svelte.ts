/**
 * App-Sperre per Face ID / Touch ID (iOS-Liste Punkt 42).
 *
 * **Gesperrt wird NUR beim echten Neustart der App** (Eigentümer-Entscheid
 * 2026-10-08). Das ist bewusst die bequeme der drei Möglichkeiten, und was sie
 * leistet, gehört dazugesagt: ein gefundenes Telefon mit BEENDETER App zeigt
 * Pulse nicht. Liegt die App im Hintergrund und jemand nimmt das entsperrte
 * Gerät, kommt er ohne Abfrage hinein. Eine Sperre nach einer Wartezeit im
 * Hintergrund (Banking-Art) wäre strenger und wurde verworfen, weil sie bei
 * jedem Blick aufs Handy im Weg steht.
 *
 * **Woran „echter Neustart" hängt, und warum das trägt:** die Hülle lädt die
 * entfernte Web-App; dieses Modul wird also genau dann neu ausgewertet, wenn
 * das Dokument neu lädt — beim Kaltstart, und wenn iOS die WebView nach
 * Speicherdruck verworfen hat. Ein Wechsel in den Hintergrund und zurück lädt
 * nicht neu und sperrt deshalb nicht. Es braucht also keinen eigenen
 * Lebenszyklus-Haken; der Modul-Zustand IST das Signal.
 *
 * **Die Einstellung liegt NICHT im Einstellungs-Store.** Sie muss gelesen
 * werden, bevor irgendetwas anderes lädt (die Sperre soll vor dem ersten
 * Inhalt stehen), und sie gehört dem GERÄT, nicht dem Konto — ein Telefon
 * sperrt man, ein Browser auf dem Rechner nicht.
 */
import { registerPlugin } from '@capacitor/core';
import { haptikTicken } from './haptik';
import { isCapacitorIOS } from './runtime';
import { sperreAusgang } from './appSperreAusgang';

interface SperrePlugin {
  verfuegbar(): Promise<{ verfuegbar: boolean }>;
  pruefen(opts: { grund: string }): Promise<{
    ok: boolean;
    abgebrochen?: boolean;
    /** `GRUND_KEIN_CODE`, wenn am Gerät kein Code mehr gesetzt ist (neuere Bauten). */
    grund?: string;
  }>;
}

const plugin = registerPlugin<SperrePlugin>('Sperre');

const SCHLUESSEL = 'pulse.appsperre';

/** Ist die Sperre auf diesem Gerät eingeschaltet? */
export function sperreAn(): boolean {
  try {
    return window.localStorage.getItem(SCHLUESSEL) === '1';
  } catch {
    // Kein Speicher: dann keine Sperre. Die harmlose Richtung — eine Sperre,
    // die man nicht abschalten kann, wäre schlimmer als keine.
    return false;
  }
}

export function sperreSetzen(an: boolean): void {
  try {
    if (an) window.localStorage.setItem(SCHLUESSEL, '1');
    else window.localStorage.removeItem(SCHLUESSEL);
  } catch {
    /* kein Speicher — dann bleibt es beim bisherigen Stand */
  }
}

/** Kann dieses Gerät überhaupt prüfen? `false` = den Schalter nicht anbieten,
 *  sonst baut man einen Knopf, der einen aussperrt. */
export async function sperreMoeglich(): Promise<boolean> {
  if (!isCapacitorIOS()) return false;
  try {
    return (await plugin.verfuegbar()).verfuegbar;
  } catch {
    return false;
  }
}

class AppSperre {
  /** `true` = die Sperrfläche liegt über der App. Beim Modul-Start gesetzt,
   *  s. Kopfkommentar — kein Lebenszyklus-Haken nötig. */
  gesperrt = $state(isCapacitorIOS() && sperreAn());
  /** Läuft gerade eine Abfrage? Gegen zwei Dialoge übereinander. */
  laeuft = $state(false);
  /** Letzter Fehlschlag, der KEIN Abbruch war — nur dann gibt es etwas zu
   *  sagen. Ein weggetippter Dialog ist keine Fehlermeldung wert. */
  fehler = $state<string | null>(null);
  /** Am Gerät ist kein Code mehr gesetzt: Entsperren ist unmöglich, die
   *  Sperrfläche bietet nur noch das Abmelden an. */
  keinCode = $state(false);
  #aufgehoben!: () => void;
  #entsperrt = new Promise<void>((weiter) => (this.#aufgehoben = weiter));

  constructor() {
    if (!this.gesperrt) this.#aufgehoben();
  }

  /**
   * Wartet, bis die Sperre aufgehoben ist — sofort, wenn sie nie stand.
   *
   * **Die Sperre hält nicht nur den Blick ab, sondern auch, was die App von
   * selbst tut** (Bughunt 2 vom 2026-10-11, F4/F5): Wiederaufnehmen,
   * Auto-Connect und Auto-Beitritt öffneten das Mikrofon im Kanal, eine
   * Antwort aus dem Mitteilungs-Banner ging hinaus — alles vor Face ID. Wer
   * etwas mit Aussenwirkung tut, ohne dass der Nutzer es in der App
   * angestossen hat, wartet hierauf.
   */
  entsperrt(): Promise<void> {
    return this.#entsperrt;
  }

  /** Ausweg von der Sperrfläche: abmelden und die Sperre aufheben — erst NACH
   *  dem vollständigen Abmelden (Server-Widerruf, Verbindungen, Speicher),
   *  sonst stünde die App entsperrt über einer halb abgebauten Sitzung. */
  async abmeldenUndAufheben(abmelden: () => Promise<void>): Promise<void> {
    try {
      await abmelden();
    } finally {
      sperreSetzen(false);
      this.#aufheben();
    }
  }

  /** Beim Zurückkehren in den Vordergrund: wer in den Einstellungen wieder
   *  einen Geräte-Code gesetzt hat, soll die Abfrage erneut anstoßen können —
   *  `keinCode` steht sonst bis zum nächsten Kaltstart und lässt nur das
   *  Abmelden übrig. */
  async codeNeuPruefen(): Promise<void> {
    if (!this.gesperrt || !this.keinCode) return;
    try {
      if ((await plugin.verfuegbar()).verfuegbar) this.keinCode = false;
    } catch {
      /* nicht erreichbar: der Stand bleibt */
    }
  }

  #aufheben(): void {
    this.gesperrt = false;
    this.#aufgehoben();
  }

  async entsperren(grund: string): Promise<void> {
    if (!this.gesperrt || this.laeuft) return;
    this.laeuft = true;
    this.fehler = null;
    try {
      const antwort = await plugin.pruefen({ grund });
      const ausgang = await sperreAusgang(
        antwort,
        async () => (await plugin.verfuegbar()).verfuegbar
      );
      if (ausgang === 'entsperrt') {
        haptikTicken(); // erfolgreich entsperrt — kurzer Tick (nur iOS-Hülle)
        this.#aufheben();
        return;
      }
      if (ausgang === 'kein_code') {
        // Der Geräte-Code wurde nach dem Einschalten entfernt: die Abfrage
        // kann nie wieder gelingen. **Die Sperre bleibt** (kein Aufschliessen
        // aus Mangel an Prüfmöglichkeit — wer das Telefon ohne Code findet,
        // käme sonst ohne jede Hürde hinein). Der Ausweg ist das Abmelden:
        // danach braucht es eine normale Anmeldung (Passwort/2FA).
        this.keinCode = true;
        return;
      }
      if (ausgang === 'fehler') this.fehler = antwort.grund || null;
    } catch (e) {
      // Plugin nicht erreichbar (alter Bau ohne das Plugin): **aufschliessen**,
      // nicht aussperren. Sonst macht ein Update, bei dem die Hülle
      // zurückbleibt, die App unbenutzbar — und die Einstellung liegt im
      // Gerät, also käme man nicht einmal an den Schalter.
      console.warn('[appSperre] Prüfung nicht erreichbar, Sperre aufgehoben', e);
      this.#aufheben();
    } finally {
      this.laeuft = false;
    }
  }
}

export const appSperre = new AppSperre();
