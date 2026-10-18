/**
 * Aus einer von aussen hereingereichten Adresse das Ziel IN der App machen.
 *
 * **Warum das geprüft gehört und nicht inline passiert:** Was hier
 * hereinkommt, hat ein Fremder geschickt — eine Nachricht, eine Webseite, ein
 * QR-Code. Die Funktion ist damit eine Grenze, und eine Grenze, die
 * `goto(irgendwas)` füttert. Sie lässt deshalb nur durch, was sie positiv
 * erkennt (Erlaubnisliste), und gibt sonst `null` zurück — der Aufrufer öffnet
 * dann einfach gar nichts.
 *
 * Drei Riegel, jeder gegen einen echten Missbrauch:
 *  - **Nur unser Haus.** Eine fremde Herkunft fällt raus; sonst öffnete ein
 *    Link auf `boese.example/app/@me/1` die App an einer Stelle, die der
 *    Angreifer wählt.
 *  - **Nur `/app/…`.** Alles andere (Impressum, Landeseite, `/login`) gehört
 *    in den Browser und wurde auch nicht beansprucht.
 *  - **Kein Protokoll-Relativ, kein `//`.** `goto('//boese.example')` wäre
 *    eine Navigation nach draussen, die wie ein Pfad aussieht.
 *
 * Importfrei bis auf den ebenfalls importfreien Einladungs-Parser, damit Nodes
 * Testläufer sie prüfen kann (s. CLAUDE.md).
 *
 * **Zwei Arten von Zielen, getrennt.** `zielPfad` liefert den Pfad in der App
 * (`/app/…`). Einladungslinks (`/invite/<code>`) liegen AUSSERHALB von `/app`
 * und haben kein Pfad-Ziel: sie öffnen den Einladungs-Dialog, nicht eine Seite
 * (`einladungsZiel`). Gast-Links (`/gast/<code>`) und die Community-Adresse
 * (`/c/<handle>`) sind bewusst keins von beidem (Eigentümer-Entscheid
 * 2026-10-18: nur Einladungslinks) — sie bleiben im Browser.
 */
import { einladungAusUrl, type Einladung } from '../einladung/einladungsLink.ts';

/** Die Herkunft, für die Universal Links beansprucht sind — dieselbe wie in
 *  `web/static/.well-known/apple-app-site-association`. */
const ERLAUBTE_HOSTS = ['howispulse.com', 'www.howispulse.com'];
const CLOUD_HOST = 'howispulse.com';

export function zielPfad(adresse: string): string | null {
  let u: URL;
  try {
    u = new URL(adresse);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!ERLAUBTE_HOSTS.includes(u.hostname.toLowerCase())) return null;
  // Genau `/app` oder darunter — `/appetit` darf nicht durchrutschen.
  if (u.pathname !== '/app' && !u.pathname.startsWith('/app/')) return null;
  const ziel = `${u.pathname}${u.search}${u.hash}`;
  // Doppelter Boden: ein Ziel, das mit `//` beginnt, ist für den Router eine
  // fremde Herkunft. Kann nach den Prüfungen oben nicht mehr auftreten —
  // steht hier, weil der Schaden gross und die Zeile billig ist.
  if (ziel.startsWith('//')) return null;
  return ziel;
}

/**
 * Aus einem Einladungslink `https://howispulse.com/invite/<code>[?host=<fqdn>]`
 * die Einladung machen — oder `null`, was nicht genau das ist.
 *
 * Dieselben Riegel wie `zielPfad` (nur https, nur unser Haus, kein Port), dazu
 * die des Einladungs-Parsers (Code-Form, `?host=` als gültiger FQDN). Der
 * Aufrufer öffnet den Dialog nicht selbst, sondern reicht die Einladung an den
 * Weg des Desktop-Deep-Links (`einladung/deepLink.ts`): angemeldet → Dialog,
 * sonst merken und nach der Anmeldung zeigen — der Beitritt bleibt ein Klick.
 */
export function einladungsZiel(adresse: string): Einladung | null {
  let u: URL;
  try {
    u = new URL(adresse);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port !== '') return null;
  if (!ERLAUBTE_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return einladungAusUrl(adresse, CLOUD_HOST, u.host);
}

/**
 * Sieht die Adresse nach einem Einladungslink von uns aus (https, unser Haus,
 * Pfad `/invite…`)? Zusammen mit einem `null` von `einladungsZiel` heißt das:
 * abgelehnt (kaputter Code, ungültiger `?host=`) — der Nutzer bekommt eine
 * Rückmeldung statt Stille.
 */
export function istEinladungsAdresse(adresse: string): boolean {
  try {
    const u = new URL(adresse);
    return (
      u.protocol === 'https:' &&
      ERLAUBTE_HOSTS.includes(u.hostname.toLowerCase()) &&
      (u.pathname === '/invite' || u.pathname.startsWith('/invite/'))
    );
  } catch {
    return false;
  }
}

/**
 * Dasselbe für einen PFAD ohne Herkunft — für Ziele, die aus der Hülle
 * zurückkommen (Schnellwahl am Icon, iOS-Punkt 44).
 *
 * **Warum das geprüft wird, obwohl der Pfad von uns selbst stammt.** Er hat
 * die App verlassen: er lag als `userInfo` in einem
 * `UIApplicationShortcutItem` und damit in einem Bereich, den das System
 * verwaltet und der einen Neustart überdauert. Was zurückkommt, ist deshalb
 * eine EINGABE, auch wenn wir sie selbst geschrieben haben — dieselbe Haltung
 * wie bei `zielPfad` gegenüber der Apple-Vorauswahl.
 *
 * Erlaubnisliste wie oben: genau `/app` oder darunter, kein `//`.
 */
export function zielPfadIntern(pfad: string): string | null {
  if (!pfad.startsWith('/')) return null;
  if (pfad.startsWith('//')) return null;
  // Genau `/app` oder darunter — `/appetit` darf nicht durchrutschen.
  if (pfad !== '/app' && !pfad.startsWith('/app/')) return null;
  return pfad;
}
