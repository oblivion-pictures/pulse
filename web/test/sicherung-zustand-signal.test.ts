import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	beiSicherungAenderung,
	sicherungGeaendert
} from '../src/lib/sicherung/zustandSignal.ts';

const KANAL_NAME = 'pulse-sicherung-zustand';

const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('eine Meldung erreicht jeden Hörer dieses Tabs sofort (synchron)', () => {
	let a = 0;
	let b = 0;
	const abA = beiSicherungAenderung(() => a++);
	const abB = beiSicherungAenderung(() => b++);
	sicherungGeaendert();
	assert.equal(a, 1);
	assert.equal(b, 1);
	abA();
	abB();
});

test('nach der Abmeldung kommt nichts mehr an, doppeltes Abmelden ist folgenlos', () => {
	let n = 0;
	const ab = beiSicherungAenderung(() => n++);
	ab();
	ab();
	sicherungGeaendert();
	assert.equal(n, 0);
	// Der Zähler darf durch das doppelte Abmelden nicht ins Minus laufen:
	// ein neuer Hörer bekommt wieder einen Kanal und hört mit.
	const ab2 = beiSicherungAenderung(() => n++);
	sicherungGeaendert();
	assert.equal(n, 1);
	ab2();
});

test('derselbe Tab meldet sich nicht doppelt (Ereignis UND Kanal)', async () => {
	let n = 0;
	const ab = beiSicherungAenderung(() => n++);
	sicherungGeaendert();
	await warte(30);
	assert.equal(n, 1);
	ab();
});

test('eine Meldung aus einem anderen Tab kommt über den Kanal an', async () => {
	let n = 0;
	const ab = beiSicherungAenderung(() => n++);
	const andererTab = new BroadcastChannel(KANAL_NAME);
	andererTab.postMessage(1);
	await warte(30);
	assert.equal(n, 1);
	andererTab.close();
	ab();
});

test('ohne Hörer hier erreicht eine Meldung trotzdem andere Tabs', async () => {
	const andererTab = new BroadcastChannel(KANAL_NAME);
	let n = 0;
	andererTab.onmessage = () => n++;
	sicherungGeaendert();
	await warte(30);
	assert.equal(n, 1);
	andererTab.close();
});
