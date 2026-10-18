import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { aktiverBereich } from '../src/lib/navigation/tabs.ts';
import { einladungsZiel, istEinladungsAdresse, zielPfad, zielPfadIntern } from '../src/lib/platform/tiefenlink.ts';

test('Chat-Adresse wird zum Ziel in der App', () => {
	assert.equal(zielPfad('https://howispulse.com/app/@me/12345'), '/app/@me/12345');
	assert.equal(zielPfad('https://www.howispulse.com/app/rooms/7'), '/app/rooms/7');
});

test('Query und Anker reisen mit', () => {
	assert.equal(
		zielPfad('https://howispulse.com/app/@me/1?ab=2#x'),
		'/app/@me/1?ab=2#x'
	);
});

test('fremde Herkunft wird abgewiesen', () => {
	// Sonst oeffnete ein fremder Link die App an einer Stelle seiner Wahl.
	assert.equal(zielPfad('https://boese.example/app/@me/1'), null);
	// Auch der Trick mit dem Hostnamen als Praefix.
	assert.equal(zielPfad('https://howispulse.com.boese.example/app/@me/1'), null);
});

test('http statt https wird abgewiesen', () => {
	assert.equal(zielPfad('http://howispulse.com/app/@me/1'), null);
});

test('Pfade ausserhalb von /app bleiben dem Browser', () => {
	assert.equal(zielPfad('https://howispulse.com/'), null);
	assert.equal(zielPfad('https://howispulse.com/impressum'), null);
	assert.equal(zielPfad('https://howispulse.com/login'), null);
	// `/appetit` darf nicht als `/app`-Praefix durchrutschen.
	assert.equal(zielPfad('https://howispulse.com/appetit'), null);
});

test('/app selbst ist erlaubt', () => {
	assert.equal(zielPfad('https://howispulse.com/app'), '/app');
});

test('Unsinn gibt null statt zu werfen', () => {
	assert.equal(zielPfad('keine-adresse'), null);
	assert.equal(zielPfad(''), null);
});

test('zielPfadIntern laesst nur App-Pfade durch', () => {
  assert.equal(zielPfadIntern('/app'), '/app');
  assert.equal(zielPfadIntern('/app/@me/123'), '/app/@me/123');
  assert.equal(zielPfadIntern('/app/rooms/7'), '/app/rooms/7');
});

test('zielPfadIntern weist alles ab, was aus der App herausfuehrt', () => {
  // Protokoll-relativ: fuer den Router eine fremde Herkunft.
  assert.equal(zielPfadIntern('//boese.example'), null);
  // Kein Pfad, sondern eine Adresse.
  assert.equal(zielPfadIntern('https://boese.example/app'), null);
  // Praefixfalle wie bei zielPfad.
  assert.equal(zielPfadIntern('/appetit'), null);
  // Alles ausserhalb der App.
  assert.equal(zielPfadIntern('/login'), null);
  assert.equal(zielPfadIntern('/'), null);
  // Relativ, also nicht eindeutig.
  assert.equal(zielPfadIntern('app/@me/1'), null);
  assert.equal(zielPfadIntern(''), null);
});

test('Widget „Ungelesen“: sein Ziel kommt durch und landet im Bereich Chats', () => {
  // Die Adresse aus der Swift-Quelle des Widgets, nicht aus einer Abschrift:
  // ein Tipp darauf geht ueber `appUrlOpen` genau durch `zielPfad`.
  const swift = readFileSync(
    new URL('../../mobile/ios/App/WidgetExtension/UngelesenWidget.swift', import.meta.url),
    'utf8'
  );
  const adresse = /URL\(string: "([^"]+)"\)/.exec(swift)?.[1];
  assert.ok(adresse, 'Adresse im Widget nicht gefunden');
  const ziel = zielPfad(adresse);
  assert.equal(ziel, '/app/@me');
  assert.equal(aktiverBereich(ziel), 'chats');
});

// Einladungslinks öffnen die App (Eigentümer-Entscheid 2026-10-18).

test('Einladungslink wird zur Einladung, Cloud ohne Host', () => {
  assert.deepEqual(einladungsZiel('https://howispulse.com/invite/abc123XY'), {
    code: 'abc123XY',
    host: null
  });
  assert.deepEqual(einladungsZiel('https://www.howispulse.com/invite/abc123XY/'), {
    code: 'abc123XY',
    host: null
  });
});

test('Einladung eines Self-Hosts trägt ihren Host mit', () => {
  assert.deepEqual(einladungsZiel('https://howispulse.com/invite/abc123XY?host=chat.example.org'), {
    code: 'abc123XY',
    host: 'chat.example.org'
  });
  // Der Cloud-Host selbst heisst Cloud.
  assert.deepEqual(einladungsZiel('https://howispulse.com/invite/abc123XY?host=howispulse.com'), {
    code: 'abc123XY',
    host: null
  });
});

test('Einladung: fremde Herkunft, http, Port und Hostnamen-Tricks werden abgewiesen', () => {
  assert.equal(einladungsZiel('https://boese.example/invite/abc123XY'), null);
  assert.equal(einladungsZiel('https://howispulse.com.boese.example/invite/abc123XY'), null);
  assert.equal(einladungsZiel('http://howispulse.com/invite/abc123XY'), null);
  assert.equal(einladungsZiel('https://howispulse.com:8443/invite/abc123XY'), null);
  // Der Parser prüft die Herkunft ZUSÄTZLICH: eine fremde Seite, die nur
  // `invite/…` im Pfad trägt, ist keine Einladung.
  assert.equal(einladungsZiel('https://discord.com/invite/abc123XY'), null);
});

test('Einladung: ungültiger Code oder Host fällt heraus statt zu werfen', () => {
  assert.equal(einladungsZiel('https://howispulse.com/invite/'), null);
  assert.equal(einladungsZiel('https://howispulse.com/invite/kurz'), null);
  assert.equal(einladungsZiel('https://howispulse.com/invite/abc123XY/mehr'), null);
  // Host mit Userinfo/Backslash: für Cloud und Browser verschieden gelesen.
  assert.equal(
    einladungsZiel('https://howispulse.com/invite/abc123XY?host=evil.example%5C@victim.example'),
    null
  );
  assert.equal(einladungsZiel('https://howispulse.com/invite/abc123XY?host=127.0.0.1'), null);
  assert.equal(einladungsZiel('keine-adresse'), null);
  assert.equal(einladungsZiel(''), null);
});

test('Gast-Links, Community-Adresse und Chat-Pfade sind keine Einladung', () => {
  assert.equal(einladungsZiel('https://howispulse.com/gast/abc123XY'), null);
  assert.equal(einladungsZiel('https://howispulse.com/c/meine-community'), null);
  assert.equal(einladungsZiel('https://howispulse.com/app/@me/1'), null);
  // Und umgekehrt: ein Einladungslink ist kein Pfad IN der App.
  assert.equal(zielPfad('https://howispulse.com/invite/abc123XY'), null);
});

test('AASA beansprucht Einladungen, aber keine Gast-Links und keine Community-Adresse', () => {
  const aasa = JSON.parse(
    readFileSync(
      new URL('../static/.well-known/apple-app-site-association', import.meta.url),
      'utf8'
    )
  );
  const pfade: string[] = aasa.applinks.details.flatMap(
    (d: { components: { '/': string }[] }) => d.components.map((c) => c['/'])
  );
  assert.ok(pfade.includes('/invite/*'));
  assert.ok(pfade.includes('/app/@me/*'));
  assert.equal(pfade.some((p) => p.startsWith('/gast') || p.startsWith('/c/')), false);
});

test('Einladungsadresse erkennen, auch wenn der Parser sie ablehnt', () => {
  assert.equal(istEinladungsAdresse('https://howispulse.com/invite/abc123XY'), true);
  assert.equal(istEinladungsAdresse('https://howispulse.com/invite/%%%'), true);
  assert.equal(einladungsZiel('https://howispulse.com/invite/%%%'), null);
  assert.equal(istEinladungsAdresse('https://howispulse.com/inviteX'), false);
  assert.equal(istEinladungsAdresse('https://howispulse.com/app/@me/1'), false);
  assert.equal(istEinladungsAdresse('https://evil.example/invite/abc123XY'), false);
  assert.equal(istEinladungsAdresse('http://howispulse.com/invite/abc123XY'), false);
  assert.equal(istEinladungsAdresse('kein link'), false);
});
