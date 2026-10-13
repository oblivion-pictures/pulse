import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { GRABSTEINE_JE_KANAL, Grabsteine, grabsteinSetzen } from '../src/lib/nachrichten/grabsteine.ts';

describe('Grabsteine: Buchführung und Grenze', () => {
	it('setzen trägt die Identität in beide Mengen ein', () => {
		const krypto = new Set<string>();
		const begraben = new Set<string>();
		grabsteinSetzen(krypto, begraben, 'k1');
		assert.deepEqual([...krypto], ['k1']);
		assert.deepEqual([...begraben], ['k1']);
	});

	it('über der Grenze fällt der älteste Grabstein aus beiden Mengen, die jüngeren bleiben', () => {
		const krypto = new Set<string>();
		const begraben = new Set<string>();
		for (let i = 0; i <= GRABSTEINE_JE_KANAL; i++) grabsteinSetzen(krypto, begraben, `k${i}`);
		assert.equal(begraben.size, GRABSTEINE_JE_KANAL);
		assert.equal(begraben.has('k0'), false);
		assert.equal(krypto.has('k0'), false, 'auch aus der Dublettenmenge, sonst wüchse sie ohne Grenze');
		assert.ok(begraben.has('k1') && krypto.has('k1'));
		assert.ok(begraben.has(`k${GRABSTEINE_JE_KANAL}`));
	});

	it('ein erneut gesetzter Grabstein rückt ans junge Ende und wird nicht doppelt gezählt', () => {
		const krypto = new Set<string>();
		const begraben = new Set<string>();
		for (let i = 0; i < GRABSTEINE_JE_KANAL; i++) grabsteinSetzen(krypto, begraben, `k${i}`);
		grabsteinSetzen(krypto, begraben, 'k0');
		assert.equal(begraben.size, GRABSTEINE_JE_KANAL);
		grabsteinSetzen(krypto, begraben, 'neu');
		assert.ok(begraben.has('k0'), 'k0 ist jetzt der jüngste, nicht der älteste');
		assert.equal(begraben.has('k1'), false, 'stattdessen fällt k1');
	});

	it('Grabsteine: je Kanal eine Menge, vergessen und leeren', () => {
		const g = new Grabsteine();
		g.fuer('a').add('x');
		assert.equal(g.fuer('a'), g.fuer('a'), 'dieselbe Menge bei jedem Zugriff');
		assert.deepEqual([...g.fuer('a')], ['x']);
		assert.equal(g.fuer('b').size, 0);
		g.vergessen('a');
		assert.equal(g.fuer('a').size, 0);
		g.fuer('b').add('y');
		g.leeren();
		assert.equal(g.fuer('b').size, 0);
	});
});
