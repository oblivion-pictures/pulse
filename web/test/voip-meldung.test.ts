import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  faehigkeitenAusHuelle,
  ketteAusZugriff,
  meldungNoetig
} from '../src/lib/platform/voipMeldung.ts';

// Nachprüfung der Fix-Runden vom 2026-10-11, S2 und S3: wann der
// PushKit-Token erneut angemeldet wird.

const k1 = { token: 'abc', kette: 'K1', faehigkeiten: ['dm_vordergrund'] };

test('erste Meldung geht raus, eine gleiche danach nicht', () => {
  assert.equal(meldungNoetig(null, k1), true);
  assert.equal(meldungNoetig(k1, { ...k1 }), false);
  assert.equal(meldungNoetig(null, { ...k1, token: '' }), false);
});

test('S3: eine neue Anmelde-Kette (Passwortwechsel) meldet neu', () => {
  assert.equal(meldungNoetig(k1, { ...k1, kette: 'K2' }), true);
  assert.equal(meldungNoetig(k1, { ...k1, kette: null }), true);
  assert.equal(meldungNoetig(k1, { ...k1, token: 'neu' }), true);
});

test('S2: geänderte Fähigkeiten melden neu, Reihenfolge zählt nicht', () => {
  assert.equal(meldungNoetig(k1, { ...k1, faehigkeiten: null }), true);
  const zwei = { ...k1, faehigkeiten: faehigkeitenAusHuelle(['b', 'a']) };
  assert.equal(meldungNoetig(zwei, { ...k1, faehigkeiten: faehigkeitenAusHuelle(['a', 'b']) }), false);
  // „Unbekannt" und „nichts" sind zweierlei.
  assert.equal(meldungNoetig({ ...k1, faehigkeiten: null }, { ...k1, faehigkeiten: [] }), true);
});

test('S2: eine ältere Hülle ohne Feld heisst „unbekannt", nie „kann nichts"', () => {
  assert.equal(faehigkeitenAusHuelle(undefined), null);
  assert.equal(faehigkeitenAusHuelle('dm_vordergrund'), null);
  assert.equal(faehigkeitenAusHuelle([1, 2]), null);
  assert.deepEqual(faehigkeitenAusHuelle([]), []);
});

test('Kette: aus dem Claim `kette`, sonst null', () => {
  assert.equal(ketteAusZugriff({ kette: 'K1', sub: '1' }), 'K1');
  assert.equal(ketteAusZugriff({ sub: '1' }), null);
  assert.equal(ketteAusZugriff({ kette: '' }), null);
  assert.equal(ketteAusZugriff(null), null);
});
