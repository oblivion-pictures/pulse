import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anzeigeName, nameVomServer, type AnzeigeEintrag } from '../src/lib/servers/anzeige.ts';
import { wirkungVonStatus } from '../src/lib/servers/instanzStatus.ts';
import {
  SERVER_NAME_MAX,
  darfServerUmbenennen,
  zuSpeichernderName,
} from '../src/lib/servers/umbenennen.ts';

// ---- Wer darf umbenennen ---------------------------------------------------

test('Umbenennen: die Cloud nie, ein Self-Host nur Admin/Besitzer DIESES Servers', () => {
  const basis = { istCloud: false, rolleLautCloud: null, adminLautServer: null } as const;
  assert.equal(darfServerUmbenennen({ ...basis, istCloud: true, adminLautServer: true }), false);
  assert.equal(darfServerUmbenennen({ ...basis, adminLautServer: true }), true);
  assert.equal(darfServerUmbenennen({ ...basis, adminLautServer: false }), false);
  assert.equal(darfServerUmbenennen(basis), false);
});

test('Umbenennen: bevor der Server etwas gesagt hat, genügt „Besitzer“ laut Cloud', () => {
  const basis = { istCloud: false, adminLautServer: null } as const;
  assert.equal(darfServerUmbenennen({ ...basis, rolleLautCloud: 'owner' }), true);
  assert.equal(darfServerUmbenennen({ ...basis, rolleLautCloud: 'member' }), false);
});

test('Umbenennen: die Auskunft des Servers gewinnt gegen die Cloud-Rolle', () => {
  // Übergabe: die Cloud führt noch den alten Besitzer, der Server sagt „kein Admin“.
  assert.equal(
    darfServerUmbenennen({ istCloud: false, rolleLautCloud: 'owner', adminLautServer: false }),
    false,
  );
  // Ein Mitglied, das der Server zum Admin gemacht hat, darf.
  assert.equal(
    darfServerUmbenennen({ istCloud: false, rolleLautCloud: 'member', adminLautServer: true }),
    true,
  );
});

// ---- Was gespeichert wird --------------------------------------------------

test('Speichern: unverändert = nichts zu tun, auch mit Rändern', () => {
  assert.equal(zuSpeichernderName('Michaels Server', 'Michaels Server'), null);
  assert.equal(zuSpeichernderName('  Michaels Server ', 'Michaels Server'), null);
  assert.equal(zuSpeichernderName('', null), null);
  assert.equal(zuSpeichernderName('   ', null), null);
});

test('Speichern: neuer Name geht getrimmt hinaus, leer = zurücksetzen (nicht null)', () => {
  assert.equal(zuSpeichernderName('  Büro Süd ', null), 'Büro Süd');
  assert.equal(zuSpeichernderName('Neu', 'Alt'), 'Neu');
  // Leer ist „zurück zur Adresse“ und muss als "" hinaus — null hieße im Server
  // „Feld nicht ändern“.
  assert.equal(zuSpeichernderName('', 'Alt'), '');
  assert.equal(zuSpeichernderName('   ', 'Alt'), '');
});

test('Speichern: die Länge folgt dem Server (60)', () => {
  assert.equal(SERVER_NAME_MAX, 60);
  assert.equal(zuSpeichernderName('x'.repeat(80), null)?.length, 60);
});

// ---- Name nach dem Speichern / vom Server ----------------------------------

const heim = (over: Partial<AnzeigeEintrag> = {}): AnzeigeEintrag => ({
  isCloud: false,
  label: 'https://selfhost.example.com',
  hostname: 'https://selfhost.example.com',
  server_name: null,
  origin: 'vps',
  ...over,
});

test('Server nennt seinen Namen: beide Felder, damit der Cloud-Altname nicht gewinnt', () => {
  const patch = nameVomServer('Michaels Server');
  assert.deepEqual(patch, { server_name: 'Michaels Server', anzeigename: 'Michaels Server' });
  // Vorher stand in der Cloud der alte Name — er darf den neuen nicht überdecken.
  const alt = heim({ server_name: 'Alt', anzeigename: 'Alt' });
  assert.equal(anzeigeName({ ...alt, ...patch }), 'Michaels Server');
});

test('Server nennt keinen Namen (leer/zurückgesetzt): zurück zur Adresse', () => {
  for (const leer of ['', '   ', null, undefined]) {
    const patch = nameVomServer(leer);
    assert.deepEqual(patch, { server_name: null, anzeigename: null });
    const alt = heim({ server_name: 'Alt', anzeigename: 'Alt' });
    assert.equal(anzeigeName({ ...alt, ...patch }), 'https://selfhost.example.com');
  }
});

// ---- instance_status: wer darf was ändern ----------------------------------

test('Status: ein Server ohne Telefonbuch-Meldung wird nie als gestoppt gewertet', () => {
  // Der Fehler vom 2026-10-12: Umbenennen schickte `online: false` für einen
  // per Gerätecode verbundenen Server und warf jeden hinunter, der darauf war.
  const w = wirkungVonStatus({ origin: 'vps' }, { online: false, anzeigename: 'Neu' }, true);
  assert.equal(w.zurueckZurCloud, false);
  assert.equal(w.offline, null);
  assert.deepEqual(w.stand, { anzeigename: 'Neu' });
  assert.equal('online' in w.stand, false);
});

test('Status: unbekannter Zustand (null) ändert nur den Namen', () => {
  for (const origin of ['vps', 'app_host', null, undefined] as const) {
    const w = wirkungVonStatus({ origin }, { online: null, anzeigename: 'Neu' }, true);
    assert.equal(w.zurueckZurCloud, false);
    assert.equal(w.offline, null);
    assert.deepEqual(w.stand, { anzeigename: 'Neu' });
  }
});

test('Status: ein gestoppter Heim-Server schickt den aktiven Nutzer zurück zur Cloud', () => {
  const w = wirkungVonStatus({ origin: 'app_host' }, { online: false, anzeigename: null }, true);
  assert.equal(w.zurueckZurCloud, true);
  assert.equal(w.offline, true);
  assert.deepEqual(w.stand, { online: false, anzeigename: null });
  // Wer nicht auf ihm ist, bleibt, wo er ist.
  assert.equal(
    wirkungVonStatus({ origin: 'app_host' }, { online: false }, false).zurueckZurCloud,
    false,
  );
});

test('Status: ein gestarteter Heim-Server ist online, niemand wird bewegt', () => {
  const w = wirkungVonStatus({ origin: 'app_host' }, { online: true, anzeigename: 'X' }, true);
  assert.equal(w.zurueckZurCloud, false);
  assert.equal(w.offline, false);
  assert.deepEqual(w.stand, { online: true, anzeigename: 'X' });
});

test('Status: der Name wird zurückgesetzt, wenn das Ereignis keinen trägt', () => {
  const w = wirkungVonStatus({ origin: 'vps' }, { online: null, anzeigename: null }, false);
  assert.deepEqual(w.stand, { anzeigename: null });
  assert.deepEqual(wirkungVonStatus({ origin: 'vps' }, {}, false).stand, { anzeigename: null });
});
