import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { PUSH_ABSCHNITT, PUSH_DM_SECTION } from '../src/lib/settings-registry/sections/pushDm.ts';

// Der DM-Schalter wird in den Server gespiegelt (`user_preferences`, Abschnitt
// `push`). Der Server schweigt NUR bei einem ausdrücklichen `false` — der
// Klient darf also nie aus Müll ein `false` machen.

const parse = PUSH_DM_SECTION.parse!;

test('Abschnittsname erfüllt das Muster der Einstellungs-Route (nur klein)', () => {
  assert.match(PUSH_ABSCHNITT, /^[a-z][a-z0-9_:-]{0,63}$/);
});

test('Vorgabe ist Push an (Bestandsverhalten)', () => {
  assert.deepEqual(PUSH_DM_SECTION.defaults, { dm: true });
  assert.deepEqual(parse(undefined), { dm: true });
  assert.deepEqual(parse(null), { dm: true });
  assert.deepEqual(parse({}), { dm: true });
});

test('nur ein Boolean wird übernommen, alles andere fällt auf an zurück', () => {
  assert.deepEqual(parse({ dm: false }), { dm: false });
  assert.deepEqual(parse({ dm: true }), { dm: true });
  assert.deepEqual(parse({ dm: 'nein' }), { dm: true });
  assert.deepEqual(parse({ dm: 0 }), { dm: true });
  assert.deepEqual(parse('false'), { dm: true });
});

test('wird mit dem Server gespiegelt und beim Abmelden zurückgesetzt', () => {
  assert.equal(PUSH_DM_SECTION.persistence, 'both');
  assert.equal(PUSH_DM_SECTION.onSignOut, 'reset');
});
