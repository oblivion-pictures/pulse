/**
 * Vorerklärung vor einem System-Berechtigungs-Dialog (iOS-Liste Punkt 36).
 *
 * Die REGEL steht geprüft in `berechtigungRegel.ts`; hier liegt der Zustand
 * (welches Blatt ist offen, was hat der Nutzer schon weggetippt) und das
 * Versprechen, auf das der Aufrufer wartet.
 *
 * **Der Aufrufer stellt den System-Dialog selbst.** Diese Datei weiss nichts
 * von Mitteilungen, Mikrofon oder Kamera — sie sagt nur „weitermachen" oder
 * „nicht". Täte sie es selbst, müsste sie `fcm.ts` und `getUserMedia`
 * kennen, und die Reihenfolge „erst erklären, dann fragen" wäre an zwei
 * Stellen verteilt statt an einer.
 */
import {
  ablehnungMerken,
  spaeterGiltNoch,
  vorgehenVorDemDialog,
  type Berechtigung,
  type Stand
} from './berechtigungRegel';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';
import { sendungenLesen } from './eigeneSendungen';

const ABGELEHNT_SCHLUESSEL = 'pulse.berechtigung';
const STAND_SCHLUESSEL = 'pulse.berechtigung.stand';

/** Je Berechtigung ein Wert, im `localStorage` als EIN JSON-Objekt. */
type Karte<Wert> = Partial<Record<Berechtigung, Wert>>;

function karteLesen<Wert>(schluessel: string): Karte<Wert> {
  try {
    const roh = window.localStorage.getItem(schluessel);
    return roh ? (JSON.parse(roh) as Karte<Wert>) : {};
  } catch {
    // Kein oder kaputter Speicher: dann wird einmal zu oft erklärt. Das ist
    // die harmlose Richtung — ein verlorenes „nein" kostet einen Tipp, ein
    // verlorenes „ja" eine Berechtigung.
    return {};
  }
}

function karteMerken<Wert>(schluessel: string, art: Berechtigung, wert: Wert): void {
  try {
    window.localStorage.setItem(
      schluessel,
      JSON.stringify({ ...karteLesen<Wert>(schluessel), [art]: wert })
    );
  } catch {
    /* Speicher voll oder abgeschaltet — dann eben nicht. */
  }
}

/**
 * Erinnerter Erlaubnis-Stand für Mikrofon und Kamera.
 *
 * **Warum erinnert und nicht gefragt.** Für Mitteilungen gibt es eine echte
 * Auskunft (`checkPermissions` des FCM-Plugins). Für Mikrofon und Kamera gibt
 * es sie in einer WKWebView NICHT: `navigator.permissions.query` kennt die
 * Namen `microphone`/`camera` dort nicht verlässlich, und ein Plugin dafür
 * wollten wir uns nicht anlegen. Ohne Stand würde die Vorerklärung bei JEDEM
 * Öffnen der Kamera erscheinen — eine Erklärung, die man täglich wegtippt,
 * ist keine Erklärung mehr.
 *
 * Der Ausweg ist der tatsächliche AUSGANG: `getUserMedia` hat geklappt =
 * erteilt, es hat mit `NotAllowedError` abgelehnt = verweigert. Beides sind
 * Belege, keine Vermutungen — nur eben nachträgliche. Die Folge: GENAU EINMAL
 * pro Gerät kann die Vorerklärung erscheinen, obwohl die Erlaubnis längst
 * vorliegt (wenn der Merker fehlt, etwa nach geleerten Website-Daten). Ein
 * Tipp zu viel in diesem Randfall gegen eine verbrannte Erlaubnis im
 * Regelfall.
 */
export function standLesen(art: Berechtigung): Stand {
  return karteLesen<Stand>(STAND_SCHLUESSEL)[art] ?? 'offen';
}

/** Den Ausgang eines echten Zugriffs merken. `erteilt` nach einem
 *  erfolgreichen `getUserMedia`, `verweigert` bei `NotAllowedError` — jeder
 *  andere Fehler (Gerät belegt, keines vorhanden) sagt über die ERLAUBNIS
 *  nichts und darf den Stand nicht anfassen. */
export function standMerken(art: Berechtigung, stand: Stand): void {
  karteMerken(STAND_SCHLUESSEL, art, stand);
}

/** `true`, wenn dieser Fehler eine ERLAUBNIS-Entscheidung war. Ein belegtes
 *  oder fehlendes Gerät ist keine. */
export function istAblehnung(e: unknown): boolean {
  return e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
}

class Berechtigungsblatt {
  /** Offenes Blatt, oder `null`. Die Komponente rendert daran. */
  offen = $state<Berechtigung | null>(null);
  #loesen: ((weiter: boolean) => void) | null = null;
  /** Wurde das offene Blatt von seinem Aufrufer zurückgezogen (`abbrechen`)? */
  #zurueckgezogen = false;

  /**
   * Vor dem System-Dialog aufrufen. Löst `true` auf, wenn der Aufrufer den
   * System-Dialog stellen soll — entweder ohne Erklärung (Browser, Lage schon
   * entschieden) oder weil der Nutzer das Blatt bestätigt hat. `false` heisst
   * „jetzt NICHT fragen": der Nutzer hat „später" getippt, oder es fehlt der
   * Anlass, oder die Erklärung wurde früher schon weggetippt, oder ein anderes
   * Blatt steht gerade offen. Ein `false` darf der Aufrufer nie mit einem
   * Dialog beantworten (Begründung an `berechtigungRegel.ts::Vorgehen`).
   */
  async fragen(art: Berechtigung, stand: Stand): Promise<boolean> {
    const vorgehen = vorgehenVorDemDialog({
      art,
      stand,
      inHuelle: isCapacitorIOS() || isCapacitorAndroid(),
      schonAbgelehnt: spaeterGiltNoch(karteLesen<unknown>(ABGELEHNT_SCHLUESSEL)[art], Date.now()),
      sendungen: sendungenLesen()
    });
    if (vorgehen === 'weiter') return true;
    if (vorgehen === 'nicht') return false;
    // Ein zweites Blatt über dem ersten wäre ein Stapel, aus dem der Nutzer
    // nicht herausfindet — der zweite Ruf wartet nicht, er lässt den
    // Aufrufer abbrechen.
    if (this.offen) return false;

    this.offen = art;
    const weiter = await new Promise<boolean>((loesen) => {
      this.#loesen = loesen;
    });
    this.offen = null;
    this.#loesen = null;
    const zurueckgezogen = this.#zurueckgezogen;
    this.#zurueckgezogen = false;
    // Ein zurückgezogenes Blatt ist keine Antwort des Nutzers — nichts merken.
    if (zurueckgezogen) return false;
    // Nur ANLASSLOSE Ablehnungen werden gemerkt — bei Mikrofon und Kamera ist
    // „später" das Abbrechen der Handlung, nicht das Ablehnen der Erklärung
    // (Begründung an `ablehnungMerken`). Gemerkt wird der ZEITPUNKT: das
    // „später" hält nur eine Weile (`spaeterGiltNoch`, iOS-Bughunt 2, F3).
    if (!weiter && ablehnungMerken(art)) karteMerken(ABGELEHNT_SCHLUESSEL, art, Date.now());
    return weiter;
  }

  /** Von der Komponente gerufen. */
  antworten(weiter: boolean): void {
    this.#loesen?.(weiter);
  }

  /**
   * Das offene Blatt dieser Art zurückziehen, weil die Handlung, die es
   * geöffnet hat, verschwunden ist (iOS-Bughunt 2, F7). Der wartende Aufrufer
   * bekommt `false`, und gemerkt wird nichts — der Nutzer hat nicht
   * geantwortet.
   *
   * Ohne das blieb die Kamera-Erklärung stehen, nachdem die Kamera-Ansicht
   * darunter schon weg war (Android: die Zurück-Taste schliesst die Ansicht,
   * nicht das Blatt). Ein „Erlauben" öffnete danach Kamera und Mikrofon für
   * eine Ansicht, die es nicht mehr gab.
   */
  abbrechen(art: Berechtigung): void {
    if (this.offen !== art || !this.#loesen) return;
    this.#zurueckgezogen = true;
    this.#loesen(false);
  }
}

export const berechtigungsblatt = new Berechtigungsblatt();
