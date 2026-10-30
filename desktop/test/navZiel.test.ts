import { test } from 'node:test';
import assert from 'node:assert/strict';
import { istErlaubtesZiel } from '../electron/navZiel.ts';

/**
 * Security-Scan 2026-10-24 (Mitte): `startLoginWatch`/`onNav` in `main.ts`
 * erkannte den Login-Erfolg der Server-App allein am PFAD (`/app…`) — der
 * Origin der Navigation wurde nie geprüft. Eine per HTTP-Redirect (30x)
 * geladene FREMDE Origin mit Pfad `/app` lud dadurch mit Preload/Bridge, und
 * `captureAuthTokens` übernahm deren „Tokens" als Server-App-Login. Diese
 * Tests halten die Quelle der Wahrheit des neuen Guards fest: Origin UND
 * Pfad — dieselbe Strenge wie `_isAllowedOrigin` plus die `/app`-Weiche.
 */

const ORIGIN = 'https://howispulse.com';

test('erlaubte Origin + /app gilt als Login-Ziel', () => {
  assert.equal(istErlaubtesZiel('https://howispulse.com/app', ORIGIN), true);
  assert.equal(istErlaubtesZiel('https://howispulse.com/app/kanal/123', ORIGIN), true);
});

test('fremde Origin mit Pfad /app wird abgelehnt — gleicher Pfad reicht nicht', () => {
  assert.equal(istErlaubtesZiel('https://evil.example/app', ORIGIN), false);
  assert.equal(istErlaubtesZiel('https://howispulse.com.evil.example/app', ORIGIN), false);
  // IP statt Hostname
  assert.equal(istErlaubtesZiel('http://127.0.0.1/app', ORIGIN), false);
});

test('erlaubte Origin mit anderem Pfad wird abgelehnt (wie bisher nur /app…)', () => {
  assert.equal(istErlaubtesZiel('https://howispulse.com/login', ORIGIN), false);
  assert.equal(istErlaubtesZiel('https://howispulse.com/', ORIGIN), false);
});

test('protokoll-relative und unbrauchbare URLs werden abgelehnt', () => {
  // `//evil.example/app` wäre gegen die Seiten-Origin aufgelöst worden —
  // new URL() ohne Basis wirft → abgelehnt (fail closed).
  assert.equal(istErlaubtesZiel('//evil.example/app', ORIGIN), false);
  assert.equal(istErlaubtesZiel('/app', ORIGIN), false);
  assert.equal(istErlaubtesZiel('keine-url', ORIGIN), false);
  assert.equal(istErlaubtesZiel('', ORIGIN), false);
});

test('abweichender Port/Protokoll ist ein anderer Origin', () => {
  assert.equal(istErlaubtesZiel('http://howispulse.com/app', ORIGIN), false);
  assert.equal(istErlaubtesZiel('https://howispulse.com:8443/app', ORIGIN), false);
});
