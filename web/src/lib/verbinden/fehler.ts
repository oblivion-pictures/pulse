/**
 * Was eine Antwort der Cloud auf der Bestätigungsseite `/verbinden` bedeutet —
 * reine Rechnung, importfrei (Node-Unit-Test).
 *
 * Quelle der Codes: `dcc_auth/routes_verbinden.py` (Etappe 1). Die Texte stehen
 * im Paraglide-Katalog unter `verbinden_*`; diese Datei nennt nur den
 * Schlüssel, damit der Test die Deckung in beiden Sprachen prüfen kann (Muster:
 * `api/anmelde-fehler-codes.ts`).
 */

/** Befunde der Nachweis-Prüfung (`verbinden_nachweis.py::nachweis_pruefen`). */
export const BEFUNDE = ['nicht_erreichbar', 'zertifikat', 'kein_nachweis', 'falscher_wert'] as const;
type Befund = (typeof BEFUNDE)[number];

export type VerbindenFehler =
  | { art: 'unbekannt' }
  /** 404 nach einem EIGENEN Klick: der Code ist verbraucht, weil der Klick wirkte. */
  | { art: 'nachsehen' }
  | { art: 'abgemeldet' }
  | { art: 'nachweis_fehlt'; befund: Befund | null }
  | { art: 'zu_viele_server' }
  | { art: 'verbinden_gesperrt' }
  /** Widerspruchsfrist (Task 1.11): der bisherige Besitzer hat widersprochen,
   *  oder ein anderes Konto wartet schon. `bis` = Ende der Sperre (ISO). */
  | { art: 'uebernahme_gesperrt'; bis: string | null }
  /** Unter der Adresse steht ein von Pulse gesperrter Eintrag. */
  | { art: 'adresse_gesperrt' }
  /** Die Cloud prüft gerade zu viele Server gleichzeitig. */
  | { art: 'ausgelastet' }
  | { art: 'nicht_verfuegbar' }
  | { art: 'gebremst' }
  | { art: 'sonst' };

function detail(body: unknown): unknown {
  return body !== null && typeof body === 'object' && 'detail' in body
    ? (body as { detail: unknown }).detail
    : undefined;
}

function istBefund(wert: unknown): wert is Befund {
  return (BEFUNDE as readonly unknown[]).includes(wert);
}

/**
 * `status` = HTTP-Status der Antwort, `null` = gar keine Antwort (Netz weg).
 *
 * `frueherAbgeschickt`: von diesem Code ging schon eine Entscheidung hinaus,
 * deren Ausgang die Seite nicht kennt. Dann heißt 404 nicht „Code ungültig“,
 * sondern „der erste Klick hat gewirkt“ — die Cloud bestätigt bis zu ~30 s
 * lang (Hinweis-Mails inline), und ein Doppelklick oder Neuladen in dieser
 * Zeit bekäme sonst eine Fehlermeldung zu einem Erfolg.
 */
export function verbindenFehler(
  status: number | null,
  body: unknown,
  frueherAbgeschickt = false
): VerbindenFehler {
  const d = detail(body);
  if (status === 404) return frueherAbgeschickt ? { art: 'nachsehen' } : { art: 'unbekannt' };
  if (status === 401) return { art: 'abgemeldet' };
  if (status === 429) return { art: 'gebremst' };
  if (status === 403 && d === 'verbinden_gesperrt') return { art: 'verbinden_gesperrt' };
  if (status === 403 && d === 'instance_suspended') return { art: 'adresse_gesperrt' };
  if (status === 503 && d === 'verbinden_ausgelastet') return { art: 'ausgelastet' };
  if (status === 503 && d === 'verbinden_nicht_verfuegbar') return { art: 'nicht_verfuegbar' };
  if (status === 409 && d === 'zu_viele_server') return { art: 'zu_viele_server' };
  if (status === 409 && d !== null && typeof d === 'object') {
    const { code, befund, bis } = d as { code?: unknown; befund?: unknown; bis?: unknown };
    if (code === 'nachweis_fehlt') {
      return { art: 'nachweis_fehlt', befund: istBefund(befund) ? befund : null };
    }
    if (code === 'uebernahme_gesperrt') {
      return { art: 'uebernahme_gesperrt', bis: typeof bis === 'string' && bis ? bis : null };
    }
  }
  return { art: 'sonst' };
}

/** Sagt die Antwort nichts darüber, ob die Entscheidung angekommen ist?
 *  Nur „sonst" (kein Netz, 5xx, Zeitüberschreitung eines Proxys): jede
 *  ausdrückliche Antwort der Cloud heißt, dass nichts geschehen ist. */
export function ausgangUngewiss(f: VerbindenFehler): boolean {
  return f.art === 'sonst';
}

/** Hat die Cloud den Vorgang mit dieser Antwort beendet? Dann gibt es nichts
 *  mehr zu bestätigen: ein zweiter Klick bekäme 404, und die Marke „es ging
 *  schon eine Entscheidung hinaus“ muss bleiben (sonst hieße ein Neuladen
 *  „gilt nicht mehr“). Gilt für die gesperrte Übernahme, das gesperrte Konto
 *  (`verbinden_gesperrt`) und den gesperrten Eintrag unter der Adresse
 *  (`adresse_gesperrt`) — die Cloud entscheidet den Vorgang dabei selbst auf
 *  „abgelehnt“ — und für 404 nach einem eigenen Klick. Ausdrücklich NICHT für
 *  `zu_viele_server` und `nachweis_fehlt`: der Vorgang wartet weiter, nach einem
 *  gelöschten Server oder einem reparierten Proxy genügt ein zweiter Klick. */
export function vorgangVerbraucht(f: VerbindenFehler): boolean {
  return (
    f.art === 'uebernahme_gesperrt' ||
    f.art === 'verbinden_gesperrt' ||
    f.art === 'adresse_gesperrt' ||
    f.art === 'nachsehen'
  );
}

/** Paraglide-Schlüssel des Hinweistextes. `null` = die Seite wechselt in einen
 *  eigenen Zustand („gilt nicht mehr“, „anmelden“, „Übernahme gesperrt“) statt
 *  einen Text zu zeigen.
 *
 *  `beimBestaetigen`: der Fehler gehört zu einer abgeschickten Entscheidung.
 *  Dann sagt „sonst“ (kein Netz, 5xx, Proxy-Abbruch) nur, dass die Antwort
 *  nicht ankam — der Klick kann trotzdem gewirkt haben. */
export function meldungsSchluessel(f: VerbindenFehler, beimBestaetigen = false): string | null {
  switch (f.art) {
    case 'unbekannt':
    case 'nachsehen':
    case 'abgemeldet':
    case 'uebernahme_gesperrt':
      return null;
    case 'nachweis_fehlt':
      return f.befund ? `verbinden_fehler_nachweis_${f.befund}` : 'verbinden_fehler_nachweis';
    case 'zu_viele_server':
      return 'verbinden_fehler_zu_viele_server';
    case 'verbinden_gesperrt':
      return 'verbinden_fehler_gesperrt';
    case 'adresse_gesperrt':
      return 'verbinden_fehler_adresse_gesperrt';
    case 'ausgelastet':
      return 'verbinden_fehler_ausgelastet';
    case 'nicht_verfuegbar':
      return 'verbinden_fehler_nicht_verfuegbar';
    case 'gebremst':
      return 'verbinden_fehler_gebremst';
    default:
      return beimBestaetigen ? 'verbinden_fehler_antwort_fehlt' : 'verbinden_fehler_sonst';
  }
}
