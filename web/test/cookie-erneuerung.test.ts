/**
 * Hält der Browser das Cookie aus `POST /session/renew`? (Vorfall 2026-10-17,
 * iOS-Hülle: das Set-Cookie einer Ablösung kam nie an, der Klient legte endlos
 * das abgelöste Cookie vor.) Hier die reine Entscheidung
 * (`cookieErneuerung.ts`, importfrei) und die Verdrahtung, die `renewSession`
 * daraus macht — die Datei selbst zieht `$lib`-Aliase nach sich und ist für
 * Nodes Läufer nicht ladbar (s. `pnpm test:unit`-Falle in CLAUDE.md).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ERNEUERUNGS_KOPF,
  NACHGEREICHT,
  PAUSE_STUFEN_MS,
  darfErneuern,
  nachErneuerung,
  neuerErneuerungsStand,
} from '../src/lib/api/cookieErneuerung.ts';

describe('nachErneuerung', () => {
  test('neue Sitzung → hält, keine Pause', () => {
    const s = neuerErneuerungsStand();
    assert.equal(nachErneuerung(s, 'neu', 0).haelt, true);
    assert.equal(darfErneuern(s, 0), true);
  });

  test('älterer Server ohne Kopf gilt wie „neu" (Verhalten wie bisher)', () => {
    const s = neuerErneuerungsStand();
    assert.equal(nachErneuerung(s, null, 0).haelt, true);
    assert.equal(nachErneuerung(s, null, 0).haelt, true);
    assert.equal(darfErneuern(s, 0), true);
  });

  test('einmal nachgereicht (Rennen zweier Tabs, Heilung) → hält', () => {
    const s = neuerErneuerungsStand();
    assert.equal(nachErneuerung(s, NACHGEREICHT, 0).haelt, true);
    assert.equal(darfErneuern(s, 0), true);
  });

  test('zweimal hintereinander nachgereicht → hält nicht, Pause', () => {
    const s = neuerErneuerungsStand();
    nachErneuerung(s, NACHGEREICHT, 0);
    assert.equal(nachErneuerung(s, NACHGEREICHT, 1_000).haelt, false);
    assert.equal(darfErneuern(s, 1_000), false);
    assert.equal(darfErneuern(s, 1_000 + PAUSE_STUFEN_MS[0] - 1), false);
    assert.equal(darfErneuern(s, 1_000 + PAUSE_STUFEN_MS[0]), true);
  });

  test('bleibt es dabei, wächst die Pause bis zur letzten Stufe', () => {
    const s = neuerErneuerungsStand();
    nachErneuerung(s, NACHGEREICHT, 0);
    let jetzt = 0;
    const pausen: number[] = [];
    for (let i = 0; i < PAUSE_STUFEN_MS.length + 2; i++) {
      assert.equal(nachErneuerung(s, NACHGEREICHT, jetzt).haelt, false);
      pausen.push((s.pauseBis ?? 0) - jetzt);
      jetzt = s.pauseBis ?? jetzt;
    }
    const letzte = PAUSE_STUFEN_MS[PAUSE_STUFEN_MS.length - 1];
    assert.deepEqual(pausen, [...PAUSE_STUFEN_MS, letzte, letzte]);
  });

  test('eine neue Sitzung hebt Pause und Zähler sofort auf', () => {
    const s = neuerErneuerungsStand();
    nachErneuerung(s, NACHGEREICHT, 0);
    nachErneuerung(s, NACHGEREICHT, 0);
    assert.equal(nachErneuerung(s, 'neu', 10).haelt, true);
    assert.equal(darfErneuern(s, 10), true);
    // Danach braucht es wieder zwei in Folge.
    assert.equal(nachErneuerung(s, NACHGEREICHT, 20).haelt, true);
  });
});

describe('Verdrahtung', () => {
  const lies = (pfad: string) => readFileSync(new URL(pfad, import.meta.url), 'utf8');

  test('Kopfname ist derselbe wie im auth-Dienst (session_renew.KOPF)', () => {
    const py = lies('../../services/auth/src/dcc_auth/session_renew.py');
    const m = py.match(/^KOPF = "([^"]+)"$/m);
    assert.ok(m, 'KOPF in session_renew.py nicht gefunden');
    assert.equal(m[1], ERNEUERUNGS_KOPF);
    assert.match(py, new RegExp(`^NACHGEREICHT = "${NACHGEREICHT}"$`, 'm'));
  });

  test('renewSession: Pause vor dem Fetch, Kopf ausgewertet, nur Haltendes zählt', () => {
    const quelle = lies('../src/lib/api/cookie-client.ts');
    const block = quelle.match(/export async function renewSession\(\)[\s\S]*?\n\}/);
    assert.ok(block, 'renewSession nicht gefunden');
    const pause = block[0].indexOf('darfErneuern(_erneuerung');
    const holen = block[0].indexOf('fetch(');
    assert.ok(pause >= 0 && holen > pause, 'Pause muss vor der Anfrage geprüft werden');
    assert.match(block[0], /nachErneuerung\(_erneuerung, resp\.headers\.get\(ERNEUERUNGS_KOPF\)/);
    // Der Zeitstempel (Grundlage von mitCloudCookie) nur für ein gehaltenes Cookie.
    const haelt = block[0].indexOf('.haelt');
    const stempel = block[0].indexOf('_cookieGepraegtAm = jetzt');
    assert.ok(haelt >= 0 && stempel > haelt, block[0]);
  });
});
