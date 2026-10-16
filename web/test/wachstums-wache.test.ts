import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	NACHLAUF_MS,
	WACHE_TAKT_MS,
	wacheLaeuftWeiter,
	wachenTick,
	wachstumsWache
} from '../src/lib/nachrichten/wachstumsWache.ts';
import { kunstUmgebung } from './hilfe-kunst-umgebung.ts';

// --- Der Tick selbst: unverändert gegenüber dem früheren Dauertakt ----------

test('Tick ohne Liste/Zeilen vergisst die gemerkte Grösse und zieht nie', () => {
	assert.deepEqual(wachenTick(1234, null, true), { letzte: 0, nachziehen: false });
});

test('Tick bei gelöstem Nutzer: merkt sich die Grösse, zieht nie', () => {
	assert.deepEqual(wachenTick(1000, 5000, false), { letzte: 5000, nachziehen: false });
});

test('Tick bei klebendem Nutzer: Wanderung über 10 px zieht nach, darunter nicht', () => {
	assert.deepEqual(wachenTick(1000, 1011, true), { letzte: 1011, nachziehen: true });
	assert.deepEqual(wachenTick(1000, 989, true), { letzte: 989, nachziehen: true });
	assert.deepEqual(wachenTick(1000, 1010, true), { letzte: 1000, nachziehen: false });
	// Kleine Schritte summieren sich, weil die gemerkte Grösse stehen bleibt.
	assert.deepEqual(wachenTick(1000, 1006, true), { letzte: 1000, nachziehen: false });
	assert.deepEqual(wachenTick(1000, 1012, true), { letzte: 1012, nachziehen: true });
});

test('wacheLaeuftWeiter: nur sichtbar und vor Ablauf des Nachlaufs', () => {
	assert.equal(wacheLaeuftWeiter(2000, 1999, false), true);
	assert.equal(wacheLaeuftWeiter(2000, 2000, false), false);
	assert.equal(wacheLaeuftWeiter(2000, 100, true), false);
});

// --- Wann er tickt --------------------------------------------------------

test('nach dem Start tickt er den Nachlauf lang im 250-ms-Takt, dann nie wieder', () => {
	const k = kunstUmgebung();
	let ticks = 0;
	wachstumsWache(() => ticks++, { umgebung: k.umgebung });
	k.spule(NACHLAUF_MS);
	assert.equal(ticks, NACHLAUF_MS / WACHE_TAKT_MS);
	assert.equal(k.offeneTimer(), 0, 'im Leerlauf kein Timer mehr');
	k.spule(60_000);
	assert.equal(ticks, NACHLAUF_MS / WACHE_TAKT_MS, 'Leerlauf: keine Weckung');
});

test('ein Anlass schaltet ihn wieder scharf, ein weiterer verlängert ohne zweiten Timer', () => {
	const k = kunstUmgebung();
	let ticks = 0;
	const w = wachstumsWache(() => ticks++, { umgebung: k.umgebung });
	k.spule(10_000);
	ticks = 0;
	w.anlass();
	k.spule(1000);
	w.anlass();
	w.anlass();
	assert.equal(k.offeneTimer(), 1);
	k.spule(NACHLAUF_MS);
	assert.equal(ticks, (1000 + NACHLAUF_MS) / WACHE_TAKT_MS);
	assert.equal(k.offeneTimer(), 0);
});

test('der letzte Tick liegt nach der letzten Änderung — die gemerkte Grösse holt auf', () => {
	// Nachgestellt: ein Bild wächst, der Anlass kommt mit der Änderung. Ein
	// Dauertakt hätte danach dieselbe Grösse gemerkt.
	const k = kunstUmgebung();
	let groesse = 1000;
	let letzte = 0;
	let gezogen = 0;
	const w = wachstumsWache(
		() => {
			const r = wachenTick(letzte, groesse, true);
			letzte = r.letzte;
			if (r.nachziehen) gezogen++;
		},
		{ umgebung: k.umgebung }
	);
	k.spule(5000);
	assert.equal(letzte, 1000);
	groesse = 1300;
	w.anlass();
	k.spule(5000);
	assert.equal(letzte, 1300);
	assert.equal(gezogen, 2, 'einmal beim Start (0 → 1000), einmal fürs Bild');
});

test('verdeckt: Anlässe zählen nicht, Sichtbarwerden ist selbst einer', () => {
	const k = kunstUmgebung();
	let ticks = 0;
	const w = wachstumsWache(() => ticks++, { umgebung: k.umgebung });
	k.spule(5000);
	ticks = 0;
	k.sicht(false);
	w.anlass();
	k.spule(10_000);
	assert.equal(ticks, 0);
	k.sicht(true);
	k.spule(NACHLAUF_MS);
	assert.equal(ticks, NACHLAUF_MS / WACHE_TAKT_MS);
});

test('wird die Seite mitten im Nachlauf verdeckt, hört er nach dem laufenden Tick auf', () => {
	const k = kunstUmgebung();
	let ticks = 0;
	wachstumsWache(() => ticks++, { umgebung: k.umgebung });
	k.spule(WACHE_TAKT_MS);
	k.sicht(false);
	k.spule(10_000);
	assert.equal(ticks, 2);
	assert.equal(k.offeneTimer(), 0);
});

test('dauerhaft (ohne MutationObserver): tickt ständig, nur verdeckt nicht', () => {
	const k = kunstUmgebung();
	let ticks = 0;
	wachstumsWache(() => ticks++, { dauerhaft: true, umgebung: k.umgebung });
	k.spule(10_000);
	assert.equal(ticks, 10_000 / WACHE_TAKT_MS);
	k.sicht(false);
	k.spule(10_000);
	assert.equal(ticks, 10_000 / WACHE_TAKT_MS + 1);
	k.sicht(true);
	k.spule(1000);
	assert.equal(ticks, 10_000 / WACHE_TAKT_MS + 1 + 1000 / WACHE_TAKT_MS);
});

test('stop: kein Tick, kein Timer, kein Hörer mehr', () => {
	const k = kunstUmgebung();
	let ticks = 0;
	const w = wachstumsWache(() => ticks++, { umgebung: k.umgebung });
	w.stop();
	w.anlass();
	k.sicht(false);
	k.sicht(true);
	k.spule(10_000);
	assert.equal(ticks, 0);
	assert.equal(k.offeneTimer(), 0);
	assert.equal(k.hoererZahl(), 0);
});
