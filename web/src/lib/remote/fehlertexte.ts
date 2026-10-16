/**
 * Fernsteuerung — die Fehlercodes des Gateways in Sätze übersetzt.
 *
 * Eigene Datei, weil der Session-Store (`session.svelte.ts`) die
 * Zustandsmaschine trägt und sonst gegen die Größen-Grenze läuft; hier steht
 * reine Textarbeit ohne Zustand. Welcher Code zu welchem Vorgang gehört, steht
 * importfrei und geprüft in `fehlerCodes.ts`.
 *
 * Die Codes vergibt `services/chat-gateway/.../ws_remote_handlers.py`
 * (4050–4056) — beim Ändern dort beide Seiten anfassen. **Seit 2026-08-16
 * kommt 4056 auch aus `ws_device_handlers.py`**: der Weckruf hat dieselbe
 * Zwei-Sekunden-Bremse bekommen wie die Anfrage, und er meldet sie mit
 * demselben Code, weil der Nutzer keinen Unterschied sieht — er hat zu schnell
 * geklickt. **Seit 2026-10-16 dazu 4060–4062** rund um Remote-Rechner
 * (`WS_FEHLER` in `api/constants.ts`).
 *
 * Seit 2026-10-16 über Paraglide statt fest deutscher Sätze.
 */

import { m } from '$lib/paraglide/messages.js';
import { weckFehlerArt } from './fehlerCodes';

/**
 * Dieselbe Lage aus zwei Quellen: die eigene Frist im Store und das
 * `remote_ended`(timeout) des Gateways. Deshalb einmal benannt — sonst bekommt
 * der Nutzer je nachdem, wer zuerst zuschlägt, einen anderen Wortlaut, sobald
 * jemand nur eine der beiden Stellen umformuliert. Eine Funktion statt einer
 * Konstante, weil eine Konstante die Sprache beim Laden des Moduls einfröre.
 */
export function keineAntwort(): string {
  return m.remote_error_no_answer();
}

/** Consent-/Erreichbarkeits-Fehlercodes (s. `ws_remote_handlers.py`). */
export function remoteErrorMessage(code: number, fallback: string): string {
  switch (code) {
    case 4051:
      return m.remote_error_no_access();
    case 4052:
      return m.remote_error_unreachable();
    case 4053:
      // Die Sitzung/Anfrage gibt es nicht mehr — beim Host der Fall, wenn er
      // erst antwortet, nachdem der Gateway die Anfrage hat verfallen lassen.
      return m.remote_error_stale();
    case 4054:
      return m.remote_error_busy();
    case 4055: {
      // Sperrfrist nach Absage/Aussitzen. Der Server schreibt die Restzeit in
      // den englischen Text ("retry in 12s") — die ist die einzige Auskunft,
      // die dem Wartenden hilft, deshalb wird sie herausgelesen statt mit dem
      // Text verworfen. Fehlt sie (anderer Wortlaut), bleibt die Aussage wahr.
      const restS = Number(/(\d+)\s*s/.exec(fallback)?.[1]);
      if (!Number.isFinite(restS)) return m.remote_error_denied_wait();
      // Singular/Plural getrennt — die Sperrfrist läuft auf 1 herunter, und
      // „Erneut möglich in 1 Sekunden" ist genau der Satz, den der Nutzer am
      // Ende jeder Wartezeit zu lesen bekäme.
      return restS === 1
        ? m.remote_error_denied_retry_one()
        : m.remote_error_denied_retry({ count: restS });
    }
    case 4056:
      // Mindestpause zwischen zwei Anfragen, je Verbindung. Trifft nur, wer
      // schneller klickt als ein Mensch klicken kann — die Restzeit ist
      // deshalb nicht der Rede wert, anders als bei der Sperrfrist oben.
      return m.remote_error_too_fast();
    case 4062:
      // Anfrage an einen Remote-Rechner ohne deckende Freigabe (seit
      // 2026-10-16) — dieselben Worte wie beim Wecken.
      return m.device_error_not_granted();
    default:
      return fallback || m.remote_error_failed();
  }
}

/**
 * Ein abgelehnter Weckruf (`fehlerCodes.ts::weckFehlerArt`) als Satz für die
 * Geräteansicht — `null`, wenn der Code nicht zum Wecken gehört.
 */
export function weckFehlerText(code: number): string | null {
  const art = weckFehlerArt(code);
  if (art === 'nicht_freigegeben') return m.device_error_not_granted();
  if (art === 'offline') return m.device_error_offline();
  if (art === 'zu_schnell') return m.remote_error_too_fast();
  return null;
}
