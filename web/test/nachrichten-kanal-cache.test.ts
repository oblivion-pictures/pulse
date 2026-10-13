import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ZuletztBenutzt } from '../src/lib/nachrichten/kanalCache.ts';

const lru = (...kanaele: string[]) => {
	const z = new ZuletztBenutzt();
	for (const k of kanaele) z.anheben(k);
	return z;
};

describe('Kanal-Cache: wer als Nächstes geräumt wird', () => {
	it('räumt nichts, solange der Deckel reicht', () => {
		assert.deepEqual(lru('a', 'b').zuRaeumen(['a', 'b'], 2), []);
	});

	it('räumt die am längsten unbenutzten zuerst, bis der Deckel passt', () => {
		assert.deepEqual(lru('a', 'b', 'c', 'd').zuRaeumen(['a', 'b', 'c', 'd'], 2), ['a', 'b']);
	});

	it('erneutes Anheben rückt einen Kanal ans junge Ende', () => {
		const z = lru('a', 'b', 'c');
		z.anheben('a');
		assert.deepEqual(z.zuRaeumen(['a', 'b', 'c'], 1), ['b', 'c']);
	});

	it('nur Kanäle mit Nachrichten zählen und kommen in Frage', () => {
		// 'a' ist in der Reihenfolge, hält aber keine Nachrichten mehr.
		assert.deepEqual(lru('a', 'b', 'c').zuRaeumen(['b', 'c'], 1), ['b']);
	});

	it('Kanäle, die nie angehoben wurden, kommen zuerst dran — in der Reihenfolge, in der sie auftraten', () => {
		// 'x' und 'y' halten Nachrichten (nur upsert), wurden aber nie geöffnet.
		assert.deepEqual(lru('a', 'b', 'c').zuRaeumen(['a', 'b', 'c', 'x'], 3), ['x']);
		assert.deepEqual(lru('a', 'b', 'c').zuRaeumen(['a', 'x', 'b', 'c', 'y'], 3), ['x', 'y']);
		assert.deepEqual(lru('a', 'b', 'c').zuRaeumen(['a', 'x', 'b', 'c', 'y'], 2), ['x', 'y', 'a']);
	});

	it('der zuletzt angehobene Kanal wird nie geräumt, auch unter lauter nie angehobenen nicht', () => {
		// Postfach-Abholung für 15 ungeöffnete Unterhaltungen, dann öffnet der
		// Nutzer 'aktiv': der Deckel (15) ist überschritten, geräumt wird ein
		// fremder Kanal — nicht der, den der Nutzer vor sich hat.
		const fremde = Array.from({ length: 15 }, (_, i) => `fremd-${i}`);
		assert.deepEqual(lru('aktiv').zuRaeumen([...fremde, 'aktiv'], 15), ['fremd-0']);
		assert.equal(lru('aktiv').zuRaeumen([...fremde, 'aktiv'], 3).includes('aktiv'), false);
	});

	it('der zuletzt angehobene Kanal bleibt, wie klein der Deckel auch ist', () => {
		assert.deepEqual(lru('a', 'b', 'c').zuRaeumen(['a', 'b', 'c'], 0), ['a', 'b']);
		// Nach erneutem Anheben ist 'a' der geschützte.
		const z = lru('a', 'b', 'c');
		z.anheben('a');
		assert.deepEqual(z.zuRaeumen(['a', 'b', 'c'], 0), ['b', 'c']);
	});

	it('entfernen nimmt einen Kanal aus der Reihenfolge', () => {
		const z = lru('a', 'b', 'c');
		z.entfernen('a');
		// Der Store räumt den Kanal zugleich aus seiner Tabelle — 'a' ist nicht mehr im Cache.
		assert.deepEqual(z.zuRaeumen(['b', 'c'], 1), ['b']);
	});

	it('leeren vergisst die Reihenfolge: danach gilt jeder Kanal als nie angehoben', () => {
		const z = lru('a', 'b', 'c');
		z.leeren();
		assert.deepEqual(z.zuRaeumen(['a', 'b', 'c'], 1), ['a', 'b']);
		assert.deepEqual(z.zuRaeumen([], 1), []);
	});
});
