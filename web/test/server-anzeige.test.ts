import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anzeigeName, instanzZeile, istSichtbar, type AnzeigeEintrag } from '../src/lib/servers/anzeige.ts';

const heim = (over: Partial<AnzeigeEintrag> = {}): AnzeigeEintrag => ({
  isCloud: false,
  label: 'https://rapid-comet-58ed.relay.example.com',
  hostname: 'https://rapid-comet-58ed.relay.example.com',
  server_name: null,
  origin: 'app_host',
  ...over,
});

test('Name: Cloud-Name vor ready-Name vor Adresse', () => {
  assert.equal(anzeigeName(heim()), 'https://rapid-comet-58ed.relay.example.com');
  assert.equal(anzeigeName(heim({ server_name: 'Alt' })), 'Alt');
  // Der Cloud-Name ist der neueste — er gewinnt gegen einen veralteten ready-Namen.
  assert.equal(anzeigeName(heim({ server_name: 'Alt', anzeigename: 'Beispiel-Server' })), 'Beispiel-Server');
  assert.equal(anzeigeName({ ...heim(), isCloud: true, label: 'Pulse Cloud', anzeigename: 'X' }), 'Pulse Cloud');
});

test('gestoppter Heim-Server verschwindet, unbekannter Zustand nicht', () => {
  assert.equal(istSichtbar(heim({ online: false })), false);
  assert.equal(istSichtbar(heim({ online: true })), true);
  assert.equal(istSichtbar(heim({ online: null })), true);
  assert.equal(istSichtbar(heim({ online: undefined })), true);
  // VPS meldet sich nicht beim Telefonbuch — nie ausblenden.
  assert.equal(istSichtbar(heim({ origin: 'vps', online: false })), true);
  assert.equal(istSichtbar({ ...heim({ online: false }), isCloud: true }), true);
});

import { instanzNachzug, type NachzugEintrag } from '../src/lib/servers/instanzNachzug.ts';

test('Nachzug übernimmt Name und Online-Zustand aus der Cloud, sonst nichts zu tun', () => {
  const e: NachzugEintrag = {
    hostname: 'https://a.relay.x', instance_id: '1', label: 'https://a.relay.x',
    notification_mode: 'mentions', origin: 'app_host', role: 'member',
  };
  const inst = { id: '1', notification_mode: 'mentions' as const, origin: 'app_host' as const, role: 'member' as const };
  // Unbekannt bleibt unbekannt — kein Schreibvorgang.
  assert.equal(instanzNachzug(e, inst, 'https://a.relay.x'), null);
  const neu = instanzNachzug(e, { ...inst, anzeigename: 'Beispiel-Server', online: false }, 'https://a.relay.x');
  assert.equal(neu?.anzeigename, 'Beispiel-Server');
  assert.equal(neu?.online, false);
  assert.equal(instanzNachzug(neu!, { ...inst, anzeigename: 'Beispiel-Server', online: false }, 'https://a.relay.x'), null);
});

const ADRESSE = 'meine-server.dcc-test.example.com';

test('Zeile: ohne Eintrag auf diesem Gerät gilt der Cloud-Name, sonst die Adresse', () => {
  assert.deepEqual(instanzZeile({ hostname: ADRESSE, anzeigename: 'Atelier' }), {
    name: 'Atelier',
    adresse: ADRESSE,
  });
  // Kein Name: die Adresse steht nur einmal da, nicht als Name UND als Unterzeile.
  assert.deepEqual(instanzZeile({ hostname: ADRESSE, anzeigename: null }), {
    name: ADRESSE,
    adresse: null,
  });
  assert.deepEqual(instanzZeile({ hostname: ADRESSE }), { name: ADRESSE, adresse: null });
});

test('Zeile: mit Eintrag folgt der Name der Leiste, nicht der Cloud-Kopie', () => {
  // Frisch umbenannt: der Server hat es dem Eintrag schon gesagt, die Cloud-
  // Liste der Seite kennt noch den alten Namen.
  const eintrag = heim({
    hostname: `https://${ADRESSE}`,
    label: `https://${ADRESSE}`,
    server_name: 'Neu',
    anzeigename: 'Neu',
  });
  assert.deepEqual(instanzZeile({ hostname: ADRESSE, anzeigename: 'Alt' }, eintrag), {
    name: 'Neu',
    adresse: ADRESSE,
  });
});

test('Zeile: der Eintrag ohne Namen zeigt die Adresse ohne Schema, wie die Leiste', () => {
  const eintrag = heim({ hostname: `https://${ADRESSE}`, label: `https://${ADRESSE}` });
  assert.deepEqual(instanzZeile({ hostname: ADRESSE, anzeigename: null }, eintrag), {
    name: ADRESSE,
    adresse: null,
  });
});
