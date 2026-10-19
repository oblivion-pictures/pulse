import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freigabeEinstellungAdresse } from '../electron/macFreigabe.ts';

test('jede bekannte Freigabe hat ihre eigene Systemeinstellungs-Adresse', () => {
  const a = freigabeEinstellungAdresse('bedienungshilfen', 'darwin');
  const b = freigabeEinstellungAdresse('eingabeueberwachung', 'darwin');
  assert.equal(a, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  assert.equal(b, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
});

test('der Renderer kann keine eigene Adresse durchreichen', () => {
  // Nur der Schlüssel reist über die Brücke; alles andere ist kein Ziel.
  for (const art of ['https://example.com', 'Privacy_Accessibility', '', null, 42, {}]) {
    assert.equal(freigabeEinstellungAdresse(art, 'darwin'), null, String(art));
  }
});

test('ausserhalb von macOS gibt es nichts zu öffnen', () => {
  assert.equal(freigabeEinstellungAdresse('bedienungshilfen', 'win32'), null);
  assert.equal(freigabeEinstellungAdresse('bedienungshilfen', 'linux'), null);
});
