import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  alsGrabstein,
  istRegisterEintrag,
  registerEintrag,
  registerEintragFuerSatz,
  registerSchluessel,
  registerSchluesselFuerSatz
} from '../src/lib/verlauf/grabsteinRegister.ts';
import { sortierSchluessel } from '../src/lib/verlauf/satz.ts';

// Gegenprüfung 2026-10-12, Fund 1: das Register merkt sich die LÖSCHUNG je
// (Konto, Kanal, Autor, kanonische Kennung), nicht den Satz. Die Regeln hier,
// der Ablauf in IndexedDB: `tests/e2e/verlauf-register.spec.ts`.

const satz = (felder: Record<string, unknown> = {}) => ({
  kontoId: 'konto',
  kanalId: '100',
  autorId: 'alice',
  nachrichtId: 'K',
  kryptoId: null as string | null,
  ...felder
});

test('Register: ohne Autor, Kennung oder Konto gibt es keinen Eintrag — nie über eine bloße ID', () => {
  assert.equal(registerSchluessel('konto', '100', '', 'K'), null);
  assert.equal(registerSchluessel('konto', '100', 'alice', ''), null);
  assert.equal(registerSchluessel('', '100', 'alice', 'K'), null);
  assert.equal(registerEintrag('konto', '100', '', 'K'), null);
  assert.equal(registerSchluesselFuerSatz(satz({ autorId: '' })), null);
});

test('Register: der Autor gehört zum Schlüssel — Bobs Löschung ist nicht Alices', () => {
  assert.notEqual(
    registerSchluessel('konto', '100', 'alice', 'K'),
    registerSchluessel('konto', '100', 'bob', 'K')
  );
  // Ebenso Kanal und Konto.
  assert.notEqual(
    registerSchluessel('konto', '100', 'alice', 'K'),
    registerSchluessel('konto', '101', 'alice', 'K')
  );
  assert.notEqual(
    registerSchluessel('konto', '100', 'alice', 'K'),
    registerSchluessel('anderes', '100', 'alice', 'K')
  );
});

test('Register: Empfangs-Kopie (D, Kennung K) und Verfasser-Kopie (K) haben denselben Schlüssel', () => {
  const verfasser = registerSchluesselFuerSatz(satz({ nachrichtId: 'K' }));
  const empfang = registerSchluesselFuerSatz(satz({ nachrichtId: 'D', kryptoId: 'K' }));
  assert.ok(verfasser);
  assert.equal(empfang, verfasser);
  assert.equal(verfasser, registerSchluessel('konto', '100', 'alice', 'K'));
  assert.deepEqual(registerEintragFuerSatz(satz({ nachrichtId: 'D', kryptoId: 'K' })), {
    schluessel: verfasser,
    grabstein: { konto: 'konto', kanal: '100', autor: 'alice', kennung: 'K' }
  });
});

test('Register: Einträge liegen außerhalb jedes Kanal-Bereichs und tragen kein kanalId/kontoId', () => {
  const eintrag = registerEintrag('konto', '700000000000000100', 'alice', '1');
  assert.ok(eintrag);
  // Der Bereich eines Kanals (`verlauf/db.ts::verlaufLesenSaetze`).
  const unten = sortierSchluessel('700000000000000100', '');
  const oben = sortierSchluessel('700000000000000100', '9'.repeat(20));
  assert.ok(eintrag.schluessel > oben || eintrag.schluessel < unten);
  // Ohne diese beiden Felder fällt der Eintrag aus dem Konto-Filter und aus
  // dem Index `nach_kanal` heraus.
  assert.ok(!('kanalId' in eintrag));
  assert.ok(!('kontoId' in eintrag));
  assert.equal(istRegisterEintrag(eintrag), true);
  assert.equal(istRegisterEintrag({ schluessel: unten }), false);
  assert.equal(istRegisterEintrag(null), false);
});

test('alsGrabstein: gelöscht, ohne Inhalt und Anhänge, Autor und Kennung bleiben', () => {
  const nachschub = { ...satz({ nachrichtId: 'K', kryptoId: 'K' }), geloescht: false, inhalt: 'geheim', anhaenge: [{ id: 'a' }] };
  assert.deepEqual(alsGrabstein(nachschub), {
    ...nachschub,
    geloescht: true,
    inhalt: '',
    anhaenge: []
  });
});
