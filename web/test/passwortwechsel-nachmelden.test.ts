import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Nach einem Passwortwechsel melden sich beide Gerätetoken unter der neuen
 * Anmelde-Kette nach (Nachtrag zu iOS-Bughunt 2, C2).
 *
 * Der Wechsel gibt diesem Gerät eine neue Kette und löscht die alte am
 * Server. Der Abgleich des chat-gateway (`geraetetoken_abgleich.py`) nennt
 * eine gelöschte Kette beendet und räumt ihre Zeilen ab — ohne Neumeldung
 * also die Zeilen genau des Geräts, das angemeldet bleibt: keine Banner (FCM),
 * kein Klingeln (PushKit), bis zur nächsten Rückkehr in den Vordergrund.
 *
 * **Warum der Test die Quelle liest:** `fcm.ts` und `voipToken.ts` ziehen
 * `$lib`-Aliase und Stores nach sich, die Nodes Testläufer nicht auflöst
 * (`pnpm test:unit`-Falle in CLAUDE.md). Gesichert wird die Verdrahtung.
 */

const abschnitt = readFileSync(
  new URL('../src/lib/components/settings/ChangePasswordSection.svelte', import.meta.url),
  'utf8'
);
const fcm = readFileSync(new URL('../src/lib/platform/fcm.ts', import.meta.url), 'utf8');

test('der Passwortwechsel meldet PushKit- und FCM-Token nach dem Wechsel neu', () => {
  assert.match(
    abschnitt,
    /await changePassword\(current, next\);[\s\S]*?voipTokenNachmelden\(\)[\s\S]*?fcmTokenNachmelden\(\)/
  );
});

test('fcmTokenNachmelden läuft über die Anmeldung von installiereFcmPush', () => {
  // Dieselbe Anmeldung wie beim Start: sie prüft die Erlaubnis und meldet nur
  // dann — ohne Hülle (Browser, Desktop) ist der Haken leer, also ein No-op.
  assert.match(
    fcm,
    /export function fcmTokenNachmelden\(\): void \{\s*anmeldenNachErlaubnis\?\.\(\);\s*\}/
  );
  assert.match(fcm, /anmeldenNachErlaubnis = meldeBestEffort;/);
});
