/**
 * Warum dieser Rechner nicht fernsteuerbar ist — in Worten, die zur richtigen
 * Systemeinstellung führen.
 *
 * **Importfrei und rein**, damit Nodes eingebauter Testläufer die Datei prüfen
 * kann (`pnpm test:unit`); wir haben kein Vitest. Muster wie
 * `lib/remote/zeigerbildPruefung.ts`.
 *
 * **Warum es diese Datei überhaupt gibt.** `stream.fernsteuerbar` sagt nur ja
 * oder nein. Auf macOS hängt die Fähigkeit an **zwei getrennten** Freigaben,
 * und die zweite fehlt fast immer, weil niemand sie erwartet — die
 * Bedienungshilfen sind bekannt, die Eingabeüberwachung nicht. Ohne diesen Text
 * sähe der Nutzer eine tote Funktion ohne Erklärung, und das ist derselbe
 * Fehler, den das Projekt an anderer Stelle schon teuer bezahlt hat:
 * unerfüllbar heißt Meldung, nicht Stille.
 */

/** Die Systemeinstellung, in die ein Hinweis führt — der Hauptprozess kennt
 *  zu jeder die feste Adresse (`desktop/electron/macFreigabe.ts`). */
export type FreigabeEinstellung = 'bedienungshilfen' | 'eingabeueberwachung';

/** Was dem Nutzer gezeigt wird. `null` heißt: es gibt nichts zu erklären. */
interface Freigabehinweis {
  ueberschrift: string;
  erklaerung: string;
  /** Wohin der Nutzer gehen muss. Leer, wenn kein Pfad benennbar ist. */
  pfad: string;
  /** Welche Einstellung „Systemeinstellungen öffnen" aufschlägt; `null` bei
   *  einem unbekannten Grund. */
  einstellung: FreigabeEinstellung | null;
  /** Bringt „Freigabe anfordern" hier noch einen Dialog von macOS? */
  anfragbar: boolean;
}

const NICHT_DER_SIDECAR = 'Freigegeben wird Pulse selbst, nicht der Sidecar.';

/**
 * `grund` ist das Feld `health.sidecar.remote_input_grund` des Sidecars.
 *
 * `kannAnfragen`: die Desktop-App hat den Anfrage-Weg (`freigabe_anfragen`,
 * seit 2026-10-19). Ältere Fassungen haben ihn nicht, und die Web-App geht
 * ihnen voraus (Merge = live, die Desktop-App erst mit Update) — dort führt
 * der Text über das Plus unter der Liste, statt einen Knopf zu nennen, den es
 * nicht gibt.
 *
 * **Ein unbekannter Grund wird durchgereicht, nicht verschluckt.** Ein
 * „unbekannter Fehler" nähme dem Nutzer die einzige Spur, die er hat, und dem
 * Entwickler den Hinweis, dass hier ein Fall fehlt.
 *
 * **Bis zum 2026-10-19 stand in jedem Hinweis, nach einem Update müsse der
 * Eintrag entfernt und neu gesetzt werden.** Das galt für das ad-hoc signierte
 * DMG; seit der Developer-ID-Signatur (Team 6FRUC2UST8) hängt die Freigabe an
 * Team und Bundle-ID, nicht an der einzelnen Fassung — gefolgert aus der
 * Signatur, über ein echtes Update hinweg noch nicht beobachtet.
 */
export function freigabeHinweis(grund: string, kannAnfragen = false): Freigabehinweis | null {
  if (!grund) return null;

  if (grund === 'bedienungshilfen') {
    const weg = kannAnfragen
      ? ' „Freigabe anfordern" bringt die Abfrage von macOS; dort die Systemeinstellungen öffnen und den Schalter bei Pulse einschalten.'
      : ' Steht Pulse noch nicht in der Liste, über das Plus darunter hinzufügen, dann den Schalter einschalten.';
    return {
      ueberschrift: 'Pulse darf keine Eingaben einspielen',
      erklaerung:
        'Ohne diese Freigabe kommt keine Maus- und Tastatureingabe des Steuernden an.' +
        weg +
        ' ' +
        NICHT_DER_SIDECAR,
      pfad: 'Systemeinstellungen > Datenschutz & Sicherheit > Bedienungshilfen',
      einstellung: 'bedienungshilfen',
      // Der Dialog kommt, solange Pulse nicht vertraut ist — auch nach einem
      // früheren Nein (Apples Beschreibung von `kAXTrustedCheckOptionPrompt`;
      // am Gerät noch nicht nachgesehen).
      anfragbar: kannAnfragen,
    };
  }

  if (grund.startsWith('eingabeueberwachung')) {
    const ungefragt = grund.slice('eingabeueberwachung'.length + 1) === 'ungefragt';
    let weg = ' Den Schalter bei Pulse einschalten.';
    if (ungefragt) {
      weg = kannAnfragen
        ? ' „Freigabe anfordern" fragt macOS nach dem Eintrag.'
        : ' Steht Pulse noch nicht in der Liste, über das Plus darunter hinzufügen.';
    }
    return {
      ueberschrift: 'Pulse darf nicht mithören',
      erklaerung:
        'Einspielen ist erlaubt, Mithören nicht. Damit greift der Vorrang nicht: ' +
        'wenn du selbst an Maus oder Tastatur gehst, bekommt Pulse das nicht mit ' +
        'und gibt dir den Rechner nicht zurück. Deshalb bleibt die Fernsteuerung aus.' +
        weg +
        ' ' +
        NICHT_DER_SIDECAR,
      pfad: 'Systemeinstellungen > Datenschutz & Sicherheit > Eingabeüberwachung',
      einstellung: 'eingabeueberwachung',
      // Nach einem Nein schweigt `IOHIDRequestAccess` — ein Knopf täte dann
      // sichtbar nichts; es bleibt der Weg über die Systemeinstellungen.
      anfragbar: kannAnfragen && ungefragt,
    };
  }

  return {
    ueberschrift: 'Fernsteuerung nicht möglich',
    erklaerung: `Der Sidecar nennt als Grund: ${grund}`,
    pfad: '',
    einstellung: null,
    anfragbar: false,
  };
}
