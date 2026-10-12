import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	KLUMPEN_ZUSATZ_BYTES,
	VORSCHAU_MAX_BYTES,
	istVorschauAbsage,
	ticketAnfordern,
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

describe('Vorschaubild abgelehnt: genau ein Neuversuch ohne Vorschaubild', () => {
	/** Ein Fehler in der Form von `ApiError` (status + message = detail). */
	const absage = (status: number, message: string) => Object.assign(new Error(message), { status });
	const VORSCHAU_ABSAGE = absage(413, 'thumbnail too large');
	const DATEI_ABSAGE = absage(413, 'file too large (600000 > 500000 bytes)');

	/** Zählt die Anfragen und antwortet nach Drehbuch. */
	function ticketQuelle(antworten: Array<'ok' | Error>) {
		const aufrufe: boolean[] = [];
		const anfordern = async (mitVorschau: boolean) => {
			aufrufe.push(mitVorschau);
			const a = antworten[aufrufe.length - 1];
			if (a instanceof Error) throw a;
			return { id: `ticket-${aufrufe.length}` };
		};
		return { aufrufe, anfordern };
	}

	it('nur die Vorschaubild-Absage zählt als solche', () => {
		assert.equal(istVorschauAbsage(VORSCHAU_ABSAGE), true);
		assert.equal(istVorschauAbsage(DATEI_ABSAGE), false); // gleicher Status, anderer Text
		assert.equal(istVorschauAbsage(absage(400, 'thumbnail too large')), false);
		assert.equal(istVorschauAbsage(absage(413, 'community storage quota exceeded (1 + 2 > 3 bytes)')), false);
		assert.equal(istVorschauAbsage(new Error('thumbnail too large')), false); // ohne Status
		assert.equal(istVorschauAbsage(null), false);
		assert.equal(istVorschauAbsage('thumbnail too large'), false);
	});

	it('Vorschaubild abgelehnt: ein zweiter Aufruf ohne Vorschaubild, dessen Antwort gilt', async () => {
		const q = ticketQuelle([VORSCHAU_ABSAGE, 'ok']);
		const r = await ticketAnfordern(q.anfordern, true);
		assert.deepEqual(q.aufrufe, [true, false]);
		assert.equal(r.mitVorschau, false);
		assert.equal(r.antwort.id, 'ticket-2');
	});

	it('angenommen beim ersten Mal: kein zweiter Aufruf', async () => {
		const q = ticketQuelle(['ok']);
		const r = await ticketAnfordern(q.anfordern, true);
		assert.deepEqual(q.aufrufe, [true]);
		assert.equal(r.mitVorschau, true);
	});

	it('„Datei zu groß“: keine Wiederholung, der Fehler geht durch', async () => {
		const q = ticketQuelle([DATEI_ABSAGE]);
		await assert.rejects(ticketAnfordern(q.anfordern, true), DATEI_ABSAGE);
		assert.deepEqual(q.aufrufe, [true]);
	});

	it('keine Schleife: scheitert auch der Neuversuch, geht dessen Fehler durch', async () => {
		// Selbst dieselbe Vorschaubild-Absage ein zweites Mal löst keinen dritten Aufruf aus.
		const q = ticketQuelle([VORSCHAU_ABSAGE, VORSCHAU_ABSAGE]);
		await assert.rejects(ticketAnfordern(q.anfordern, true), VORSCHAU_ABSAGE);
		assert.deepEqual(q.aufrufe, [true, false]);

		const p = ticketQuelle([VORSCHAU_ABSAGE, DATEI_ABSAGE]);
		await assert.rejects(ticketAnfordern(p.anfordern, true), DATEI_ABSAGE);
		assert.deepEqual(p.aufrufe, [true, false]);
	});

	it('ohne Vorschaubild von Anfang an: genau ein Aufruf, auch bei einer Absage', async () => {
		const q = ticketQuelle([VORSCHAU_ABSAGE]);
		await assert.rejects(ticketAnfordern(q.anfordern, false), VORSCHAU_ABSAGE);
		assert.deepEqual(q.aufrufe, [false]);
	});
});
