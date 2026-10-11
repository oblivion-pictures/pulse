import { goto, onNavigate } from '$app/navigation';
import { herkunftEinordnen, type Herkunft } from './herkunft';

/**
 * Die Herkunft der letzten Navigation — die Regel und ihre Begründung stehen
 * in `herkunft.ts`, hier nur die Verdrahtung.
 *
 * **Warum `onNavigate` und nicht `afterNavigate`:** `onNavigate` läuft, BEVOR
 * die neue Seite gezeichnet wird — der Effekt der Kanal-Route liest also
 * schon die Herkunft der Navigation, die ihn ausgelöst hat. `afterNavigate`
 * käme erst danach, und die Route entschiede auf der Herkunft der vorigen.
 *
 * **Kein `$state`:** gelesen wird der Wert nur im Augenblick der Landung;
 * dass er sich danach ändert, soll niemanden aufwecken.
 */

/** Bis zur ersten Navigation in der App ist die gezeigte Seite die erste des
 *  Dokuments. Für sie ruft SvelteKit `onNavigate` nicht. */
let aktuell: Herkunft = 'start';
let aussenZiel: string | null = null;

export function navigationsHerkunft(): Herkunft {
  return aktuell;
}

/**
 * Einmal im Root-Layout rufen, während der Initialisierung (`onNavigate`
 * verlangt das). Das Root-Layout, nicht `app/+layout`: das hängt beim Weg von
 * der Anmeldung in die App erst nach der Navigation ein, die es lädt, und
 * hinterliesse die Herkunft von vor dem Abmelden.
 */
export function navigationsHerkunftVerfolgen(): void {
  onNavigate((nav) => {
    aktuell = herkunftEinordnen(nav.type, nav.to?.url.pathname ?? '', aussenZiel);
    // **Die Marke gilt genau für die nächste Navigation.** Startet zwischen
    // Marke und Landung eine zweite, bricht SvelteKit die erste ab und ruft
    // `onNavigate` nur für die zweite: liegt die auf einem anderen Pfad, ist
    // sie richtig `app`, und eine liegengebliebene Marke darf keine spätere
    // Navigation auf demselben Pfad falsch einordnen.
    aussenZiel = null;
  });
}

/**
 * Ein Ziel öffnen, das von AUSSERHALB der Seite kommt — Universal Link,
 * Mitteilung, Schnellwahl am Symbol. Es landet wie jedes andere, aber ohne
 * die Folgen eines Tipps in der App (kein Beitritt zum Sprachkanal, D1).
 */
export function vonAussenOeffnen(ziel: string): Promise<void> {
  aussenZiel = ziel;
  return goto(ziel);
}
