import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anzeigeName,
  cloudNameAnwenden,
  nameVomServer,
  type AnzeigeEintrag,
} from '../src/lib/servers/anzeige.ts';
import { instanzNachzug, type NachzugEintrag } from '../src/lib/servers/instanzNachzug.ts';
import { standAnwenden, wirkungVonStatus } from '../src/lib/servers/instanzStatus.ts';
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

test('Speichern: geschnitten wird nach Codepunkten, ein Emoji wird nicht zerrissen', () => {
  // 59 Zeichen + zwei Emoji (je ein Surrogatpaar, zwei UTF-16-Einheiten): nach
  // Einheiten läge der Schnitt mitten im zweiten Emoji.
  const eingabe = 'x'.repeat(59) + '\u{1F600}\u{1F601}';
  const r = zuSpeichernderName(eingabe, null) ?? '';
  assert.equal(Array.from(r).length, 60);
  assert.equal(r, 'x'.repeat(59) + '\u{1F600}');
  // Kein einzelnes (halbes) Surrogat am Ende.
  assert.equal(/[\uD800-\uDBFF]$/.test(r), false);
  // Der Server zählt Codepunkte: genau 60 Emoji sind erlaubt und bleiben ganz.
  const sechzig = '\u{1F600}'.repeat(60);
  assert.equal(zuSpeichernderName(sechzig, null), sechzig);
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
  const alt = heim({ server_name: 'Alt', anzeigename: 'Alt' });
  const patch = nameVomServer('Michaels Server', alt);
  assert.deepEqual(patch, {
    server_name: 'Michaels Server',
    anzeigename: 'Michaels Server',
    // Die Cloud-Kopie „Alt“ ist damit überholt und soll nicht zurückspringen.
    name_ueberholt: 'Alt',
  });
  // Vorher stand in der Cloud der alte Name — er darf den neuen nicht überdecken.
  assert.equal(anzeigeName({ ...alt, ...patch }), 'Michaels Server');
});

test('Server nennt dasselbe wie die Cloud, oder die Cloud kannte keinen Namen: nichts überholt', () => {
  assert.equal(nameVomServer('X', { anzeigename: 'X' }).name_ueberholt, null);
  assert.equal(nameVomServer('X', { anzeigename: null }).name_ueberholt, null);
  assert.equal(nameVomServer('X').name_ueberholt, null);
});

test('Neuverbinden mit unverändertem Namen behält die Marke, die Cloud-Kopie springt nicht zurück', () => {
  // Umbenannt A → B, die Meldung des Servers an die Cloud steht noch aus.
  const nachUmbenennen = nameVomServer('B', { anzeigename: 'A' });
  assert.equal(nachUmbenennen.name_ueberholt, 'A');
  // Neuverbinden: der ready-Rahmen nennt wieder B.
  const nachReady = nameVomServer('B', nachUmbenennen);
  assert.equal(nachReady.name_ueberholt, 'A');
  // Der nächste Cloud-Abgleich meldet noch A — B bleibt stehen.
  assert.deepEqual(cloudNameAnwenden(nachReady, 'A'), { anzeigename: 'B', name_ueberholt: 'A' });
  // Hat die Cloud aufgeholt, fällt die Marke weg.
  assert.deepEqual(cloudNameAnwenden(nachReady, 'B'), { anzeigename: 'B', name_ueberholt: null });
});

test('Server nennt keinen Namen (leer/zurückgesetzt): zurück zur Adresse', () => {
  for (const leer of ['', '   ', null, undefined]) {
    const alt = heim({ server_name: 'Alt', anzeigename: 'Alt' });
    const patch = nameVomServer(leer, alt);
    assert.deepEqual(patch, { server_name: null, anzeigename: null, name_ueberholt: 'Alt' });
    assert.equal(anzeigeName({ ...alt, ...patch }), 'https://selfhost.example.com');
  }
});

// ---- Rücksprung auf den alten Cloud-Namen ----------------------------------

test('Cloud-Kopie: der überholte Wert springt nicht zurück, alles andere gilt', () => {
  const e = { anzeigename: 'Neu', name_ueberholt: 'Alt' };
  // Die Meldung des Servers an die Cloud ist gescheitert: sie nennt weiter „Alt“.
  assert.deepEqual(cloudNameAnwenden(e, 'Alt'), { anzeigename: 'Neu', name_ueberholt: 'Alt' });
  // Die Cloud hat aufgeholt: derselbe Name, der Marker fällt weg.
  assert.deepEqual(cloudNameAnwenden(e, 'Neu'), { anzeigename: 'Neu', name_ueberholt: null });
  // Oder sie nennt einen noch neueren.
  assert.deepEqual(cloudNameAnwenden(e, 'Noch neuer'), {
    anzeigename: 'Noch neuer',
    name_ueberholt: null,
  });
  // Oder gar keinen (zurückgesetzt): dann zeigt der Eintrag server_name bzw. die Adresse.
  assert.deepEqual(cloudNameAnwenden(e, null), { anzeigename: null, name_ueberholt: null });
});

test('Cloud-Kopie: ohne Marker übernimmt die Cloud wie bisher', () => {
  assert.deepEqual(cloudNameAnwenden({ anzeigename: 'A' }, 'B'), {
    anzeigename: 'B',
    name_ueberholt: null,
  });
  assert.deepEqual(cloudNameAnwenden({}, undefined), { anzeigename: null, name_ueberholt: null });
});

test('Abgleich mit der Cloud (/me/instances): der Servername springt nicht auf den alten zurück', () => {
  const vorher: NachzugEintrag = {
    hostname: 'https://selfhost.example.com',
    instance_id: '1',
    label: 'https://selfhost.example.com',
    notification_mode: 'mentions',
    origin: 'vps',
    role: 'owner',
    server_name: 'Neu',
    anzeigename: 'Neu',
    name_ueberholt: 'Alt',
  } as NachzugEintrag;
  const inst = {
    id: '1',
    notification_mode: 'mentions' as const,
    origin: 'vps' as const,
    role: 'owner' as const,
  };
  // Cloud kennt noch „Alt“: nichts zu tun, der Eintrag bleibt bei „Neu“.
  assert.equal(instanzNachzug(vorher, { ...inst, anzeigename: 'Alt' }, 'https://selfhost.example.com'), null);
  // Cloud hat aufgeholt: Marker weg.
  const aufgeholt = instanzNachzug(vorher, { ...inst, anzeigename: 'Neu' }, 'https://selfhost.example.com');
  assert.equal(aufgeholt?.anzeigename, 'Neu');
  assert.equal(aufgeholt?.name_ueberholt, null);
  // Cloud nennt etwas Neues: gilt.
  const neuer = instanzNachzug(vorher, { ...inst, anzeigename: 'Ganz neu' }, 'https://selfhost.example.com');
  assert.equal(neuer?.anzeigename, 'Ganz neu');
  assert.equal(neuer?.name_ueberholt, null);
});

test('Statusereignis der Cloud: der überholte Name springt nicht zurück', () => {
  const e = { online: null, anzeigename: 'Neu', name_ueberholt: 'Alt' };
  // Ereignis mit der alten Kopie: nichts zu ändern.
  assert.equal(standAnwenden(e, { anzeigename: 'Alt' }), null);
  // Ereignis mit dem Namen des Servers: der Marker fällt weg.
  const aufgeholt = standAnwenden(e, { anzeigename: 'Neu' });
  assert.equal(aufgeholt?.anzeigename, 'Neu');
  assert.equal(aufgeholt?.name_ueberholt, null);
  // Ein Ereignis ohne Namensfeld (nur online) lässt den Namen in Ruhe.
  const nurOnline = standAnwenden(e, { online: true });
  assert.equal(nurOnline?.online, true);
  assert.equal(nurOnline?.anzeigename, 'Neu');
  assert.equal(nurOnline?.name_ueberholt, 'Alt');
});

test('Rücksprung Ende zu Ende: Server nennt B, Cloud sagt A, dann holt sie auf', () => {
  let e = heim({ server_name: 'A', anzeigename: 'A' }) as AnzeigeEintrag & {
    name_ueberholt?: string | null;
  };
  e = { ...e, ...nameVomServer('B', e) }; // Server meldet B (ready / Speichern)
  assert.equal(anzeigeName(e), 'B');
  e = { ...e, ...(standAnwenden(e, { anzeigename: 'A' }) ?? {}) }; // Cloud kennt noch A
  assert.equal(anzeigeName(e), 'B');
  e = { ...e, ...(standAnwenden(e, { anzeigename: 'B' }) ?? {}) }; // Cloud holt auf
  assert.equal(anzeigeName(e), 'B');
  assert.equal(e.name_ueberholt, null);
  e = { ...e, ...(standAnwenden(e, { anzeigename: 'C' }) ?? {}) }; // später: anderer Name
  assert.equal(anzeigeName(e), 'C');
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
