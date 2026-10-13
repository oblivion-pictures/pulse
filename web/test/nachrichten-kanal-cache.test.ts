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
		// 'a' ist in der Reihenfolge, hält aber keine Nachrichten mehr; 'x' hält
		// welche, wurde aber nie angehoben und steht deshalb nicht dran.
		assert.deepEqual(lru('a', 'b', 'c').zuRaeumen(['b', 'c', 'x'], 2), ['b']);
	});

	it('entfernen und leeren nehmen Kanäle aus der Reihenfolge', () => {
		const z = lru('a', 'b', 'c');
		z.entfernen('a');
		assert.deepEqual(z.zuRaeumen(['a', 'b', 'c'], 1), ['b', 'c']);
		z.leeren();
		assert.deepEqual(z.zuRaeumen(['a', 'b', 'c'], 1), []);
	});
});
