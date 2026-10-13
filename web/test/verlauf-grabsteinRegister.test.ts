import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  alsGrabstein,
  istRegisterEintrag,
  registerEintrag,
  registerEintragFuerSatz,
  registerSchluessel,
  registerSchluesselFuerSatz,
  uebernommeneLoeschungen
} from '../src/lib/verlauf/grabsteinRegister.ts';
import { sortierSchluessel } from '../src/lib/verlauf/satz.ts';

// Gegenprüfung 2026-10-12, Fund 1: das Register merkt sich die LÖSCHUNG je
// (Konto, Kanal, Autor, kanonische Kennung), nicht den Satz. Die Regeln hier,
// der Ablauf in IndexedDB: `tests/e2e/verlauf-register.spec.ts`.

// Autor und Kennung haben die Form echter IDs — seit Fund 1 der zweiten
// Gegenprüfung nimmt das Register nichts anderes mehr an.
const ALICE = '200';
const BOB = '300';
const K = '1760000000000123456';
const D = '120000000000000001';

const satz = (felder: Record<string, unknown> = {}) => ({
  kontoId: 'konto',
  kanalId: '100',
  autorId: ALICE,
  nachrichtId: K,
  kryptoId: null as string | null,
  ...felder
});

test('Register: ohne Autor, Kennung oder Konto gibt es keinen Eintrag — nie über eine bloße ID', () => {
  assert.equal(registerSchluessel('konto', '100', '', K), null);
  assert.equal(registerSchluessel('konto', '100', ALICE, ''), null);
  assert.equal(registerSchluessel('', '100', ALICE, K), null);
  assert.equal(registerEintrag('konto', '100', '', K), null);
  assert.equal(registerSchluesselFuerSatz(satz({ autorId: '' })), null);
});

test('Register: eine Kennung, die keine Ziffernfolge ist, trägt nichts ein (Fund 1)', () => {
  // Die Kennung eines Lösch-Frames wählt der Absender frei. `"x"` stand bis
  // hierher als Eintrag im Register und als Stein in der Sicherung, und deren
  // Leser warf beim Sortieren (`BigInt("x")`).
  for (const kennung of ['x', '12a', '-1', '0123', '1'.repeat(21), ' 12']) {
    assert.equal(registerSchluessel('konto', '100', ALICE, kennung), null, kennung);
    assert.equal(registerEintrag('konto', '100', ALICE, kennung), null, kennung);
  }
  // Ebenso ein Autor, der keine Konto-ID ist.
  assert.equal(registerSchluessel('konto', '100', 'alice', K), null);
  assert.equal(registerSchluesselFuerSatz(satz({ kryptoId: 'x' })), null);
  // Die Grenzen echter IDs bleiben gültig.
  assert.ok(registerSchluessel('konto', '100', ALICE, '9'.repeat(20)));
  assert.ok(registerSchluessel('konto', '100', ALICE, '1'));
});

test('Register: der Autor gehört zum Schlüssel — Bobs Löschung ist nicht Alices', () => {
  assert.notEqual(
    registerSchluessel('konto', '100', ALICE, K),
    registerSchluessel('konto', '100', BOB, K)
  );
  // Ebenso Kanal und Konto.
  assert.notEqual(
    registerSchluessel('konto', '100', ALICE, K),
    registerSchluessel('konto', '101', ALICE, K)
  );
  assert.notEqual(
    registerSchluessel('konto', '100', ALICE, K),
    registerSchluessel('anderes', '100', ALICE, K)
  );
});

test('Register: Empfangs-Kopie (D, Kennung K) und Verfasser-Kopie (K) haben denselben Schlüssel', () => {
  const verfasser = registerSchluesselFuerSatz(satz({ nachrichtId: K }));
  const empfang = registerSchluesselFuerSatz(satz({ nachrichtId: D, kryptoId: K }));
  assert.ok(verfasser);
  assert.equal(empfang, verfasser);
  assert.equal(verfasser, registerSchluessel('konto', '100', ALICE, K));
  assert.deepEqual(registerEintragFuerSatz(satz({ nachrichtId: D, kryptoId: K })), {
    schluessel: verfasser,
    grabstein: { konto: 'konto', kanal: '100', autor: ALICE, kennung: K }
  });
});

test('Register: Einträge liegen außerhalb jedes Kanal-Bereichs und tragen kein kanalId/kontoId', () => {
  const eintrag = registerEintrag('konto', '700000000000000100', ALICE, '1');
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
  const nachschub = { ...satz({ nachrichtId: K, kryptoId: K }), geloescht: false, inhalt: 'geheim', anhaenge: [{ id: '5' }] };
  assert.deepEqual(alsGrabstein(nachschub), {
    ...nachschub,
    geloescht: true,
    inhalt: '',
    anhaenge: []
  });
});

// Gegenprüfung 2026-10-14, V1: ein Sicherungs-Stein ohne Autor markiert auf
// dem alten Gerät nur den Satz unter seiner lokalen ID — aber der Satz trägt
// Autor und Kennung, und die Kopplung trug ihn auf dem neuen Gerät über
// genau diese ins Register ein. Er löste dort doch über die Kennung auf.
test('V1: ein ungebundener Grabstein der Kopplung trägt nichts ein und trifft nur seinen Schlüssel', () => {
  const ungebunden = {
    ...satz(),
    schluessel: sortierSchluessel('100', K),
    geloescht: true,
    loeschungUngebunden: true as const
  };
  const gebunden = {
    ...satz({ nachrichtId: D, kryptoId: '1760000000000999999' }),
    schluessel: sortierSchluessel('100', D),
    geloescht: true
  };
  const { eintraege, nurSelbst } = uebernommeneLoeschungen([ungebunden, gebunden], 'konto');
  assert.deepEqual(
    eintraege.map((e) => e.grabstein.kennung),
    ['1760000000000999999'],
    'nur der gebundene Grabstein steht im Register'
  );
  assert.deepEqual([...nurSelbst], [sortierSchluessel('100', K)]);
});

test('uebernommeneLoeschungen: sichtbare Sätze und fremde Konten zählen nicht', () => {
  const sichtbar = { ...satz(), schluessel: 'a', geloescht: false };
  const fremd = {
    ...satz(),
    kontoId: 'anderes',
    schluessel: 'b',
    geloescht: true,
    loeschungUngebunden: true as const
  };
  const { eintraege, nurSelbst } = uebernommeneLoeschungen([sichtbar, fremd], 'konto');
  assert.deepEqual(eintraege, []);
  assert.equal(nurSelbst.size, 0);
});
