/**
 * Login-Ziel-Prüfung der Server-App — importfrei (bis auf node:url), damit
 * die Guard-Rechnung ohne Electron lauffähig und testbar ist
 * (`test/navZiel.test.ts`; das Muster von `deeplink.ts`).
 *
 * Security-Scan 2026-10-24 (Mitte): `startLoginWatch`/`onNav` in `main.ts`
 * erkannte den Login-Erfolg allein am PFAD (`pathname.startsWith('/app')`).
 * HTTP-Redirects (30x) lösen `will-navigate` nicht aus, also konnte eine
 * umgeleitete FREMDE Origin mit Pfad `/app` geladen werden — mit Preload/
 * Bridge — und `captureAuthTokens` übernahm deren „Tokens" als Server-App-
 * Login (der Welt-Schalter). Der Guard verlangt deshalb jetzt beides:
 * Origin-Gleichheit ( dieselbe Strenge wie `_isAllowedOrigin` in `main.ts`)
 * UND den `/app`-Pfad. Alles Unparsebare (auch protokoll-relative
 * `//evil.example/app`) wird abgelehnt — fail closed.
 */

import { URL } from 'node:url';

/** Wahr genau dann, wenn `url` auf `erlaubteOrigin` liegt UND den Pfad
 *  `/app…` trägt — die Bedingungen, unter denen `startLoginWatch` den
 *  Login als gelungen wertet und Tokens der geladenen Seite übernimmt.
 *  `erlaubteOrigin` ist der Origin, gegen den der Watch gestartet wurde
 *  (Login-Realm), nicht eine hartcodierte Konstante. */
export function istErlaubtesZiel(url: string, erlaubteOrigin: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === erlaubteOrigin && u.pathname.startsWith('/app');
  } catch {
    return false;
  }
}
