import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	DEFAULT_ATTACH_MAX_COUNT,
	DEFAULT_ATTACH_MAX_SIZE_BYTES,
	bytesToUnit,
	ceilingOrDefault
} from '../src/lib/components/admin/communityLimitFormat.ts';

const MB = 1024 * 1024;

describe('Betreiber-Obergrenzen für Dateien: was der leere Platzhalter nennt', () => {
	it('nie gesetzte Obergrenze (null) zeigt den Instanz-Standard, nicht 0', () => {
		const wert = bytesToUnit(ceilingOrDefault(null, DEFAULT_ATTACH_MAX_SIZE_BYTES), MB);
		assert.equal(wert, 25);
		assert.equal(ceilingOrDefault(null, DEFAULT_ATTACH_MAX_COUNT), 4);
	});

	it('eine gesetzte Obergrenze gewinnt', () => {
		assert.equal(bytesToUnit(ceilingOrDefault(50 * MB, DEFAULT_ATTACH_MAX_SIZE_BYTES), MB), 50);
		assert.equal(ceilingOrDefault(10, DEFAULT_ATTACH_MAX_COUNT), 10);
	});

	it('0 ist eine echte Obergrenze und fällt nicht auf den Standard durch', () => {
		assert.equal(ceilingOrDefault(0, DEFAULT_ATTACH_MAX_COUNT), 0);
	});
});
