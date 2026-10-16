import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sichtbarerTakt, wartezeit } from '../src/lib/utils/sichtbarerTakt.ts';
import { kunstUmgebung } from './hilfe-kunst-umgebung.ts';

test('wartezeit: ohne Vorlauf sofort, sonst der Rest bis zum Termin, nie negativ', () => {
	assert.equal(wartezeit(null, 500, 1000), 0);
	assert.equal(wartezeit(0, 300, 1000), 700);
	assert.equal(wartezeit(0, 1000, 1000), 0);
	assert.equal(wartezeit(0, 5000, 1000), 0);
});

test('sichtbar: erster Lauf synchron beim Start, danach im Abstand', () => {
	const k = kunstUmgebung();
	let laeufe = 0;
	sichtbarerTakt(() => laeufe++, 1000, { umgebung: k.umgebung });
	assert.equal(laeufe, 1, 'synchron wie f(); setInterval(f)');
	k.spule(999);
	assert.equal(laeufe, 1);
	k.spule(1);
	assert.equal(laeufe, 2);
	k.spule(3000);
	assert.equal(laeufe, 5);
});

test('sofort:false wartet einen vollen Abstand', () => {
	const k = kunstUmgebung();
	let laeufe = 0;
	sichtbarerTakt(() => laeufe++, 1000, { sofort: false, umgebung: k.umgebung });
	assert.equal(laeufe, 0);
	k.spule(1000);
	assert.equal(laeufe, 1);
});

test('verdeckt: kein Lauf, kein offener Timer — die Seite wird nicht geweckt', () => {
	const k = kunstUmgebung();
	let laeufe = 0;
	sichtbarerTakt(() => laeufe++, 1000, { umgebung: k.umgebung });
	k.sicht(false);
	assert.equal(k.offeneTimer(), 0);
	k.spule(60_000);
	assert.equal(laeufe, 1);
});

test('Sichtbarwerden nach überfälligem Termin: sofort nachholen, dann wieder im Takt', () => {
	const k = kunstUmgebung();
	let laeufe = 0;
	sichtbarerTakt(() => laeufe++, 1000, { umgebung: k.umgebung });
	k.sicht(false);
	k.spule(10_000);
	k.sicht(true);
	assert.equal(laeufe, 2, 'genau EIN Nachholer, nicht zehn');
	k.spule(999);
	assert.equal(laeufe, 2);
	k.spule(1);
	assert.equal(laeufe, 3);
});

test('kurz verdeckt (Termin noch nicht um): kein Extralauf, Termin bleibt wie ohne Pause', () => {
	const k = kunstUmgebung();
	let laeufe = 0;
	sichtbarerTakt(() => laeufe++, 120_000, { umgebung: k.umgebung });
	k.spule(10_000);
	k.sicht(false);
	k.spule(5_000);
	k.sicht(true);
	assert.equal(laeufe, 1, 'Tab-Hin-und-Her löst keine Anfrage aus');
	k.spule(104_999);
	assert.equal(laeufe, 1);
	k.spule(1);
	assert.equal(laeufe, 2, 'genau zum ursprünglichen Termin');
});

test('verdeckt schon beim Start: erster Lauf erst beim Sichtbarwerden', () => {
	const k = kunstUmgebung();
	k.sicht(false);
	let laeufe = 0;
	sichtbarerTakt(() => laeufe++, 1000, { umgebung: k.umgebung });
	assert.equal(laeufe, 0);
	k.sicht(true);
	assert.equal(laeufe, 1);
});

test('mehrfache Sichtwechsel-Meldungen ohne Wechsel planen keinen zweiten Timer', () => {
	const k = kunstUmgebung();
	let laeufe = 0;
	sichtbarerTakt(() => laeufe++, 1000, { umgebung: k.umgebung });
	k.sicht(true);
	k.sicht(true);
	assert.equal(k.offeneTimer(), 1);
	k.spule(1000);
	assert.equal(laeufe, 2);
});

test('Stopper: kein Lauf mehr, Timer und Hörer weg — auch nach Sichtbarwerden', () => {
	const k = kunstUmgebung();
	let laeufe = 0;
	const stopp = sichtbarerTakt(() => laeufe++, 1000, { umgebung: k.umgebung });
	stopp();
	assert.equal(k.offeneTimer(), 0);
	assert.equal(k.hoererZahl(), 0);
	k.sicht(false);
	k.sicht(true);
	k.spule(5000);
	assert.equal(laeufe, 1);
});

test('ein werfender Lauf hält den Takt nicht an und nimmt dem Start nicht den Stopper', async () => {
	const k = kunstUmgebung();
	let laeufe = 0;
	const geworfen: unknown[] = [];
	const alt = globalThis.queueMicrotask;
	globalThis.queueMicrotask = (f) => {
		try {
			f();
		} catch (e) {
			geworfen.push(e);
		}
	};
	try {
		const stopp = sichtbarerTakt(
			() => {
				laeufe++;
				throw new Error('kaputt');
			},
			1000,
			{ umgebung: k.umgebung }
		);
		assert.equal(typeof stopp, 'function');
		k.spule(2000);
		assert.equal(laeufe, 3);
		assert.equal(geworfen.length, 3, 'der Fehler bleibt sichtbar');
		stopp();
	} finally {
		globalThis.queueMicrotask = alt;
	}
});
