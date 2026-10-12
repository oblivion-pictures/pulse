import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	KLUMPEN_ZUSATZ_BYTES,
	VORSCHAU_MAX_BYTES,
	vorschauBehalten
} from '../src/lib/attachments/vorschauWahl.ts';

describe('Vorschaubild: wird es mit hochgeladen?', () => {
	it('ein normales WebP wird behalten', () => {
		assert.equal(vorschauBehalten('image/webp', 60_000), true);
		// Größtes WebP, das 720x720 hergibt (gemessen ~0,9 MB, mit Alphakanal).
		assert.equal(vorschauBehalten('image/webp', 913_000), true);
	});

	it('Safari-Rückfall: ein PNG wird weggelassen, auch wenn es klein genug wäre', () => {
		// toBlob('image/webp') liefert dort still ein PNG.
		assert.equal(vorschauBehalten('image/png', 300_000), false);
		assert.equal(vorschauBehalten('image/png', 2_188_607), false);
	});

	it('ein leerer Typ (Browser meldet nichts) wird weggelassen', () => {
		assert.equal(vorschauBehalten('', 50_000), false);
	});

	it('ein WebP genau auf der Grenze wird behalten, ein Byte darüber nicht', () => {
		assert.equal(vorschauBehalten('image/webp', VORSCHAU_MAX_BYTES), true);
		assert.equal(vorschauBehalten('image/webp', VORSCHAU_MAX_BYTES + 1), false);
	});

	it('der verschlüsselte Weg rechnet den Zuschlag des Klumpens mit', () => {
		const knapp = VORSCHAU_MAX_BYTES - KLUMPEN_ZUSATZ_BYTES;
		assert.equal(vorschauBehalten('image/webp', knapp, KLUMPEN_ZUSATZ_BYTES), true);
		assert.equal(vorschauBehalten('image/webp', knapp + 1, KLUMPEN_ZUSATZ_BYTES), false);
	});

	it('trägt das größte rohe 720x720-RGBA-PNG mit der Grenze des Servers', () => {
		// Rohgröße 720 * 720 * 4 = 2.073.600; gemessen als PNG bis 2.188.607.
		// Die Grenze muss darüber liegen, sonst scheitern alte Klienten am 413.
		assert.ok(VORSCHAU_MAX_BYTES > 2_188_607);
	});
});
