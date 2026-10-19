import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostPlattform, reiterSichtbar } from '../src/lib/devices/reiterSichtbar.ts';

test('Windows-Rechner sieht den Reiter immer', () => {
  assert.equal(
    reiterSichtbar({
      kannStandplatzSein: true,
      hostPlattform: false,
      hatEintragung: false,
      besitztGeraete: false,
    }),
    true,
  );
});

test('Linux mit eigenen Geraeten sieht ihn — das ist der neue Fall', () => {
  assert.equal(
    reiterSichtbar({
      kannStandplatzSein: false,
      hostPlattform: false,
      hatEintragung: false,
      besitztGeraete: true,
    }),
    true,
  );
});

test('Linux mit alter Eintragung sieht ihn — sonst kaeme er nie wieder los', () => {
  assert.equal(
    reiterSichtbar({
      kannStandplatzSein: false,
      hostPlattform: false,
      hatEintragung: true,
      besitztGeraete: false,
    }),
    true,
  );
});

test('Linux ohne alles sieht ihn nicht', () => {
  assert.equal(
    reiterSichtbar({
      kannStandplatzSein: false,
      hostPlattform: false,
      hatEintragung: false,
      besitztGeraete: false,
    }),
    false,
  );
});

// ── Einstieg nach Plattform (2026-10-19) ─────────────────────────────────────
// Bis dahin hing der Einstieg allein an der gemessenen Fähigkeit, gemessen
// wurde aber nur bei Voice-Beitritt, Einstellungen, Stream-Dialog oder
// vorhandener Eintragung. Ein frisch installierter Rechner sah den Knopf nie.

test('Mac oder Windows ohne Messung und ohne Geraete sieht den Einstieg', () => {
  for (const os of ['darwin', 'win32']) {
    assert.equal(hostPlattform({ electron: true, os, sidecarBruecke: true }), true, os);
    assert.equal(
      reiterSichtbar({
        kannStandplatzSein: false,
        hostPlattform: true,
        hatEintragung: false,
        besitztGeraete: false,
      }),
      true,
      os,
    );
  }
});

test('Linux ist keine Host-Plattform', () => {
  assert.equal(hostPlattform({ electron: true, os: 'linux', sidecarBruecke: true }), false);
});

test('ohne Electron oder ohne Sidecar-Bruecke keine Host-Plattform', () => {
  assert.equal(hostPlattform({ electron: false, os: 'darwin', sidecarBruecke: true }), false);
  assert.equal(hostPlattform({ electron: true, os: 'win32', sidecarBruecke: false }), false);
  assert.equal(hostPlattform({ electron: true, os: undefined, sidecarBruecke: true }), false);
});
