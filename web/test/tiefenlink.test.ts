import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { aktiverBereich } from '../src/lib/navigation/tabs.ts';
import { zielPfad, zielPfadIntern } from '../src/lib/platform/tiefenlink.ts';

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
