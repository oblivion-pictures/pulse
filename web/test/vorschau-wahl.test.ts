import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	KLUMPEN_ZUSATZ_BYTES,
	VORSCHAU_MAX_BYTES,
	vorschauBehalten
} from '../src/lib/attachments/vorschauWahl.ts';

describe('Vorschaubild: wird es mit hochgeladen?', () => {
	it('ein normales WebP wird behalten', () => {
		assert.equal(vorschauBehalten(60_000), true);
		// Größtes WebP, das 720x720 hergibt (gemessen ~0,9 MB, mit Alphakanal).
		assert.equal(vorschauBehalten(913_000), true);
	});

	it('Safari/iOS-Rückfall: das PNG unter der Grenze wird behalten', () => {
		// toBlob('image/webp') liefert dort still ein PNG, ein Mehrfaches eines
		// WebP; so lief Safari bis heute, und die Vorschaubilder blieben erhalten.
		assert.equal(vorschauBehalten(300_000), true);
		assert.equal(vorschauBehalten(2_188_607), true); // größtes 720x720-RGBA-PNG
	});

	it('genau auf der Grenze wird behalten, ein Byte darüber nicht', () => {
		assert.equal(vorschauBehalten(VORSCHAU_MAX_BYTES), true);
		assert.equal(vorschauBehalten(VORSCHAU_MAX_BYTES + 1), false);
	});

	it('ein übergroßes Vorschaubild wird weggelassen', () => {
		assert.equal(vorschauBehalten(5 * 1024 * 1024), false);
	});

	it('der verschlüsselte Weg rechnet den Zuschlag des Klumpens mit', () => {
		const knapp = VORSCHAU_MAX_BYTES - KLUMPEN_ZUSATZ_BYTES;
		assert.equal(vorschauBehalten(knapp, KLUMPEN_ZUSATZ_BYTES), true);
		assert.equal(vorschauBehalten(knapp + 1, KLUMPEN_ZUSATZ_BYTES), false);
	});

	it('trägt das größte rohe 720x720-RGBA-PNG mit der Grenze des Servers', () => {
		// Rohgröße 720 * 720 * 4 = 2.073.600; gemessen als PNG bis 2.188.607.
		// Die Grenze muss darüber liegen, sonst scheitern alte Klienten am 413.
		assert.ok(VORSCHAU_MAX_BYTES > 2_188_607);
	});
});
