import { goto, onNavigate } from '$app/navigation';
import { herkunftEinordnen, type Herkunft, type Marke } from './herkunft';

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
let marke: Marke | null = null;

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
    aktuell = herkunftEinordnen(nav.type, nav.to?.url.pathname ?? '', marke);
    // **Die Marke gilt genau für die nächste Navigation.** Startet zwischen
    // Marke und Landung eine zweite, bricht SvelteKit die erste ab und ruft
    // `onNavigate` nur für die zweite: liegt die auf einem anderen Pfad, ist
    // sie richtig `app`, und eine liegengebliebene Marke darf keine spätere
    // Navigation auf demselben Pfad falsch einordnen.
    marke = null;
  });
}

/**
 * Ein Ziel öffnen, das von AUSSERHALB der Seite kommt — Universal Link,
 * Mitteilung, Schnellwahl am Symbol. Es landet wie jedes andere, aber ohne
 * die Folgen eines Tipps in der App (kein Beitritt zum Sprachkanal, D1).
 */
export function vonAussenOeffnen(ziel: string): Promise<void> {
  marke = { ziel, herkunft: 'aussen' };
  return goto(ziel);
}

/**
 * Eine Weiterleitung, die die App selbst auslöst — kein Tipp, also auch kein
 * Beitritt der Kanal-Route (S1, Begründung in `herkunft.ts`). `optionen`
 * gehen unverändert an `goto` (`replaceState` für die Startseite).
 */
export function weiterleiten(
  ziel: string,
  optionen?: Parameters<typeof goto>[1]
): Promise<void> {
  marke = { ziel, herkunft: 'weiterleitung' };
  return goto(ziel, optionen);
}
