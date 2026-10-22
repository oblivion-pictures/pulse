/**
 * Laufzeit des Eingabewegs auf der Host-Seite (`electron/eingabeLaufzeit.ts`).
 * Der Uhrenversatz der beiden Rechner muss herausfallen, ein Anstau muss sich
 * zeigen, und ohne Stempel darf nichts erscheinen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EingabeLaufzeit, MELDE_TAKT_MS } from '../electron/eingabeLaufzeit.ts';

test('der Uhrenversatz faellt heraus: gleichmaessige Laufzeit heisst null ueber dem Minimum', () => {
  const l = new EingabeLaufzeit();
  const versatz = -33_000; // der Host geht 33 s nach
  for (let i = 0; i < 100; i++) {
    const jetzt = 1_000_000 + i * 100;
    l.erfassen('s1', jetzt - versatz - 20, jetzt); // 20 ms Laufzeit
  }
  const zeile = l.faellig(1_000_000 + MELDE_TAKT_MS);
  assert.ok(zeile?.includes('p50 0 / p95 0 / max 0 ms'), zeile ?? 'keine Zeile');
  // Geht der Host nach, ist der Rohwert negativ: 20 ms Laufzeit minus 33 s.
  assert.ok(zeile?.includes('Sitzungsminimum roh -32980 ms'), zeile ?? '');
});

test('ein Anstau zeigt sich als Laufzeit ueber dem Minimum', () => {
  const l = new EingabeLaufzeit();
  for (let i = 0; i < 100; i++) {
    const jetzt = 2_000_000 + i * 100;
    l.erfassen('s1', jetzt - 20 - i, jetzt); // waechst von 20 auf 119 ms
  }
  const zeile = l.faellig(2_000_000 + MELDE_TAKT_MS) ?? '';
  assert.match(zeile, /p50 49 \/ p95 94 \/ max 99 ms/);
});

test('erst nach einem Takt eine Zeile, zum Schluss sofort, ohne Stempel nie', () => {
  const l = new EingabeLaufzeit();
  l.erfassen('s1', undefined, 0);
  assert.equal(l.faellig(MELDE_TAKT_MS, true), null, 'ohne t keine Probe');
  l.erfassen('s1', 0, 10);
  assert.equal(l.faellig(1_000), null, 'vor Ablauf des Takts nichts');
  assert.ok(l.faellig(2_000, true), 'zum Schluss sofort');
  assert.equal(l.faellig(3_000, true), null, 'danach ist das Fenster leer');
});

test('eine neue Sitzung beginnt mit frischem Minimum', () => {
  const l = new EingabeLaufzeit();
  l.erfassen('alt', 0, 5); // 5 ms
  l.erfassen('neu', 0, 500); // neue Sitzung: 500 ms ist ihr Minimum
  l.erfassen('neu', 1_000, 1_500);
  const zeile = l.faellig(500 + MELDE_TAKT_MS) ?? '';
  assert.match(zeile, /n=2\): ueber dem Sitzungsminimum p50 0 \/ p95 0 \/ max 0 ms; Sitzungsminimum roh 500 ms/);
});
