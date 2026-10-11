import { test } from 'node:test';
import assert from 'node:assert/strict';

import { darfMelden, MINDESTABSTAND_MS } from '../src/lib/platform/badgeDrossel.ts';
import type { Drosselstand } from '../src/lib/platform/badgeDrossel.ts';

test('derselbe Wert wird nicht erneut gemeldet', () => {
	assert.equal(darfMelden({ letzterWert: 3, letzteZeit: 0, bereit: true }, 3, 10_000_000), false);
});

test('die erste Meldung geht sofort raus', () => {
	// Ein frisch gestartetes Gerät darf den Serverstand nicht erst nach der
	// Drosselfrist korrigieren.
	assert.equal(darfMelden({ letzterWert: null, letzteZeit: 0, bereit: true }, 2, 1_000), true);
});

test('alles gelesen schlaegt die Drossel', () => {
	// Die 0 ist die Meldung, auf die es ankommt: die Plakette muss sofort weg.
	assert.equal(darfMelden({ letzterWert: 5, letzteZeit: 9_900, bereit: true }, 0, 10_000), true);
});

test('eine neue Zahl innerhalb der Frist wartet', () => {
	const stand = { letzterWert: 1, letzteZeit: 10_000, bereit: true };
	assert.equal(darfMelden(stand, 2, 10_000 + MINDESTABSTAND_MS - 1), false);
});

test('nach Ablauf der Frist darf die neue Zahl raus', () => {
	const stand = { letzterWert: 1, letzteZeit: 10_000, bereit: true };
	assert.equal(darfMelden(stand, 2, 10_000 + MINDESTABSTAND_MS), true);
});

test('vor der Freigabe wird gar nichts gemeldet', () => {
	// Der Fall vom Geraetetest 08.10.: beim Start ist die Ungelesen-Lage noch
	// nicht geladen, der Klient rechnet 0 — und haette damit die korrekte 3
	// des Servers geloescht. Auch die sonst bevorrechtigte 0 muss hier
	// schweigen.
	const stand = { letzterWert: null, letzteZeit: 0, bereit: false };
	assert.equal(darfMelden(stand, 0, 1_000), false);
	assert.equal(darfMelden(stand, 5, 1_000), false);
});

test('nach der Freigabe gilt die normale Regel wieder', () => {
	const stand = { letzterWert: null, letzteZeit: 0, bereit: true };
	assert.equal(darfMelden(stand, 5, 1_000), true);
});

test('nach dem Wiederverbinden geht derselbe Wert erneut raus (T12)', async () => {
	// Die Cloud zählt selbst hoch, während keine Verbindung steht. Rechnet
	// die App danach dieselbe Zahl wie vorher, muss sie sie trotzdem melden —
	// sonst bleibt der Zaehler am Server auf dem falschen Sockel.
	const { serverStandUnsicher } = await import('../src/lib/platform/badgeDrossel.ts');
	const stand = { letzterWert: 3, letzteZeit: 10_000, bereit: true };
	assert.equal(darfMelden(stand, 3, 10_001), false);
	serverStandUnsicher(stand);
	assert.equal(darfMelden(stand, 3, 10_001), true);
});

test('eine aufgeschobene Zahl bekommt ihre Wartezeit statt verworfen zu werden (C3)', async () => {
	// iOS-Bughunt 2, C3: innerhalb der Frist fiel die Zahl bisher weg — kam
	// danach keine Änderung mehr, blieb der Server auf dem Wert davor.
	const { wartezeit } = await import('../src/lib/platform/badgeDrossel.ts');
	const stand = { letzterWert: 1, letzteZeit: 10_000, bereit: true };
	assert.equal(wartezeit(stand, 2, 11_000), MINDESTABSTAND_MS - 1_000);
	assert.equal(wartezeit(stand, 2, 10_000 + MINDESTABSTAND_MS), 0);
	assert.equal(wartezeit(stand, 1, 11_000), null);
	assert.equal(wartezeit({ ...stand, bereit: false }, 2, 11_000), null);
	assert.equal(wartezeit(stand, 0, 11_000), 0);
});

test('nach einer Zustellung bei wacher App geht derselbe Wert gedrosselt erneut raus (C1)', async () => {
	// Der Server pusht seit C1 auch an ein wachendes iPhone und zählt dabei
	// hoch. Wurde die Nachricht sofort gelesen, bleibt die Zahl hier gleich —
	// sie muss trotzdem zurück zum Server, aber nicht öfter als die Frist erlaubt.
	const { serverHatGezaehlt, wartezeit } = await import('../src/lib/platform/badgeDrossel.ts');
	const stand: Drosselstand = { letzterWert: 3, letzteZeit: 10_000, bereit: true };
	assert.equal(wartezeit(stand, 3, 11_000), null);
	serverHatGezaehlt(stand);
	assert.equal(wartezeit(stand, 3, 11_000), MINDESTABSTAND_MS - 1_000);
	assert.equal(wartezeit(stand, 3, 10_000 + MINDESTABSTAND_MS), 0);
});
