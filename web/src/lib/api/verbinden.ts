/**
 * Bestätigungsseite `/verbinden` gegen auth-svc (Spec 2026-10-09, E1/E5;
 * Routen aus `routes_verbinden.py`). Cookie-Auth wie `instancesApi`.
 *
 * Der Code reist im Anfragekörper, nie im Pfad: Pfade landen in den
 * Zugriffsprotokollen von nginx/Caddy — genau das, was das `#` in der
 * Adresse der Seite vermeidet (Vertrag, Nachtrag 2). Er geht in Anzeigeform
 * (`XXXX-XXXX`) hinaus; die Cloud normalisiert selbst. Nie loggen — wer ihn
 * bestätigt, wird Besitzer eines Servers.
 *
 * Fehler kommen als `ApiError` (Status + Körper) heraus; was sie bedeuten,
 * rechnet `lib/verbinden/fehler.ts`.
 */
import { cookieFetch } from './cookie-client';

/** Spiegelt die Antwort von `POST /me/selfhost/verbinden/vorgang`. */
export interface Verbindung {
  hostname: string;
  gueltig_bis: string;
  /** Unter dieser Adresse steht ein aktiver Eintrag eines ANDEREN Kontos:
   *  Bestätigen beantragt dann nur eine Übernahme (72 h Widerspruchsfrist).
   *  Kein Name, keine Nummer des Besitzers — die Seite warnt nur. */
  adresse_vergeben: boolean;
}

/** Spiegelt die Antwort von `POST /me/selfhost/verbinden/entscheidung`.
 *  `verbunden` | `abgelehnt` | `uebernahme_beantragt` (dann mit `frist_bis`). */
export interface VerbindenErgebnis {
  status: string;
  hostname?: string;
  instance_id?: string;
  frist_bis?: string;
}

export function holeVerbindung(code: string): Promise<Verbindung> {
  return cookieFetch<Verbindung>('/me/selfhost/verbinden/vorgang', {
    method: 'POST',
    body: { code }
  });
}

/** Kann bis ~30 s dauern: die Cloud prüft den Nachweis des Servers und
 *  verschickt die Hinweis-Mails, bevor sie antwortet. */
export function entscheideVerbindung(
  code: string,
  aktion: 'verbinden' | 'ablehnen'
): Promise<VerbindenErgebnis> {
  return cookieFetch<VerbindenErgebnis>('/me/selfhost/verbinden/entscheidung', {
    method: 'POST',
    body: { code, aktion }
  });
}
