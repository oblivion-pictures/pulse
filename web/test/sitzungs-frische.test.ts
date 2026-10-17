/**
 * Cloud-Sitzung vor dem Cookie-Request (Konsolen-401 auf …/direct-endpoint).
 *
 * Ursache: das `pulse_session`-Cookie bekommt `Max-Age=1800` nur beim
 * Anmelden und bei `/session/renew` — 30 Minuten nach der letzten Erneuerung
 * ist es im Browser weg, auch bei dauernder Benutzung. Ein nackter
 * `fetch(…, { credentials: 'include' })` danach (App-Host-Anwesenheit alle
 * 2 Minuten, Telefonbuch-Nachschlag des Direktpfads) bekam 401, und beim
 * App-Start rannte der erste Takt der Erneuerung davon. Hier die reine
 * Entscheidung (`sitzungsFrische.ts`, importfrei) samt Ablauf.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COOKIE_LEBENSDAUER_MS,
  RESERVE_MS,
  mitCloudSitzung,
  sitzungMussErneuertWerden,
  type SitzungsHaken,
} from '../src/lib/api/sitzungsFrische.ts';

const MIN = 60_000;

describe('sitzungMussErneuertWerden', () => {
  test('nie erneuert (frische Seite) → einmal erneuern', () => {
    assert.equal(sitzungMussErneuertWerden(null, 1_000_000, false), true);
  });

  test('frisch geprägt → kein Umweg', () => {
    const t0 = 5_000_000;
    assert.equal(sitzungMussErneuertWerden(t0, t0, false), false);
    assert.equal(sitzungMussErneuertWerden(t0, t0 + 10 * MIN, false), false);
  });

  test('knapp vor der Reserve noch gut, ab der Reserve erneuern', () => {
    const t0 = 5_000_000;
    const grenze = COOKIE_LEBENSDAUER_MS - RESERVE_MS;
    assert.equal(sitzungMussErneuertWerden(t0, t0 + grenze - 1, false), false);
    assert.equal(sitzungMussErneuertWerden(t0, t0 + grenze, false), true);
  });

  test('Cookie längst abgelaufen (Rechner hat geschlafen) → erneuern', () => {
    const t0 = 5_000_000;
    assert.equal(sitzungMussErneuertWerden(t0, t0 + 3 * 60 * MIN, false), true);
  });

  test('Uhr zurückgestellt (negatives Alter) → dem Zeitstempel nicht trauen', () => {
    assert.equal(sitzungMussErneuertWerden(5_000_000, 4_000_000, false), true);
  });

  test('läuft gerade eine Erneuerung → abwarten, auch bei frischem Stempel', () => {
    // Sie tauscht das Cookie aus und entwertet das alte; eine Anfrage
    // dazwischen kommt mit dem toten an.
    const t0 = 5_000_000;
    assert.equal(sitzungMussErneuertWerden(t0, t0 + MIN, true), true);
  });

  test('die Reserve liegt innerhalb der Lebensdauer', () => {
    assert.ok(RESERVE_MS > 0 && RESERVE_MS < COOKIE_LEBENSDAUER_MS);
  });
});

/** Baukasten: protokolliert die Reihenfolge der Aufrufe. */
function haken(opt: {
  belegtAm?: number | null;
  jetzt?: number;
  laeuft?: boolean;
  erneuern?: () => Promise<boolean>;
  antworten: number[];
}) {
  const log: string[] = [];
  let n = 0;
  const h: SitzungsHaken<{ status: number }> = {
    jetzt: () => opt.jetzt ?? 10_000_000,
    belegtAm: () => (opt.belegtAm === undefined ? 10_000_000 : opt.belegtAm),
    erneuerungLaeuft: () => opt.laeuft ?? false,
    erneuere: async () => {
      log.push('erneuern');
      return opt.erneuern ? opt.erneuern() : true;
    },
    anfrage: async () => {
      log.push('anfrage');
      return { status: opt.antworten[Math.min(n++, opt.antworten.length - 1)] };
    },
  };
  return { h, log };
}

describe('mitCloudSitzung', () => {
  test('frische Sitzung → nur die Anfrage, kein Umweg über die Erneuerung', async () => {
    const { h, log } = haken({ antworten: [200] });
    const r = await mitCloudSitzung(h);
    assert.equal(r?.status, 200);
    assert.deepEqual(log, ['anfrage']);
  });

  test('abgelaufene Sitzung → ERST erneuern, dann fragen (kein 401 in der Konsole)', async () => {
    const { h, log } = haken({ belegtAm: 1_000_000, jetzt: 1_000_000 + 40 * MIN, antworten: [200] });
    const r = await mitCloudSitzung(h);
    assert.equal(r?.status, 200);
    assert.deepEqual(log, ['erneuern', 'anfrage']);
  });

  test('App-Start: die Anfrage wartet die laufende Erneuerung ab', async () => {
    let fertig: (ok: boolean) => void = () => {};
    const { h, log } = haken({
      laeuft: true,
      erneuern: () => new Promise<boolean>((r) => (fertig = r)),
      antworten: [200],
    });
    const lauf = mitCloudSitzung(h);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(log, ['erneuern'], 'Anfrage darf nicht vor der Erneuerung rausgehen');
    fertig(true);
    assert.equal((await lauf)?.status, 200);
    assert.deepEqual(log, ['erneuern', 'anfrage']);
  });

  test('Erneuerung scheitert → die Anfrage geht GAR NICHT raus (sie wäre ein 401)', async () => {
    const { h, log } = haken({ belegtAm: null, erneuern: async () => false, antworten: [200] });
    assert.equal(await mitCloudSitzung(h), null);
    assert.deepEqual(log, ['erneuern']);
  });

  test('401 trotz belegter Sitzung (serverseitig beendet) → einmal erneuern, einmal wiederholen', async () => {
    const { h, log } = haken({ antworten: [401, 200] });
    const r = await mitCloudSitzung(h);
    assert.equal(r?.status, 200);
    assert.deepEqual(log, ['anfrage', 'erneuern', 'anfrage']);
  });

  test('401, Erneuerung scheitert → das 401 kommt zurück, keine Wiederholung', async () => {
    const { h, log } = haken({ erneuern: async () => false, antworten: [401, 200] });
    const r = await mitCloudSitzung(h);
    assert.equal(r?.status, 401);
    assert.deepEqual(log, ['anfrage', 'erneuern']);
  });

  test('zweimal 401 → es bleibt bei EINER Wiederholung', async () => {
    const { h, log } = haken({ antworten: [401, 401, 200] });
    const r = await mitCloudSitzung(h);
    assert.equal(r?.status, 401);
    assert.deepEqual(log, ['anfrage', 'erneuern', 'anfrage']);
  });

  test('andere Statuswerte (404, 502) lösen keine Erneuerung aus', async () => {
    for (const status of [404, 429, 502]) {
      const { h, log } = haken({ antworten: [status] });
      assert.equal((await mitCloudSitzung(h))?.status, status);
      assert.deepEqual(log, ['anfrage']);
    }
  });
});

describe('Verdrahtung: kein nackter Cookie-Fetch auf das Telefonbuch', () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const lies = (pfad: string) => readFileSync(join(webRoot, pfad), 'utf8');

  for (const datei of [
    'src/lib/stores/appHostAnwesenheit.svelte.ts',
    'src/lib/direct/registry.ts',
  ]) {
    test(`${datei}: direct-endpoint nur über mitCloudCookie`, () => {
      const quelle = lies(datei);
      assert.match(quelle, /mitCloudCookie\(\s*`[^`]*\/direct-endpoint`/);
      // Ein `fetch(` mit dieser Adresse wäre der alte Weg: ohne Sitzung → 401.
      assert.doesNotMatch(quelle, /\bfetch\(\s*`[^`]*\/direct-endpoint`/);
    });
  }

  test('Abmelden vergisst den Prägezeitpunkt', () => {
    assert.match(lies('src/lib/stores/auth.svelte.ts'), /cloudSitzungVergessen\(\)/);
  });

  test('renewSession merkt sich den Zeitpunkt nur bei Erfolg', () => {
    const quelle = lies('src/lib/api/cookie-client.ts');
    // Seit 2026-10-17 zählt nur ein Cookie, das der Browser auch hält
    // (`cookieErneuerung.ts`, Reihenfolge geprüft in cookie-erneuerung.test.ts).
    assert.match(quelle, /if \(!resp\.ok\) return false;[\s\S]*?_cookieGepraegtAm = jetzt;/);
  });
});
