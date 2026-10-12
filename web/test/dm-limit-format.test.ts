import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	DM_MIN_BYTES,
	bytesToMiB,
	dmSizeToSave
} from '../src/lib/components/admin/dmLimitFormat.ts';

const MIB = 1024 * 1024;

describe('DM-Dateigröße: Anzeige', () => {
	it('zeigt 0,5 MiB als 0,5 und nicht als 1', () => {
		assert.equal(bytesToMiB(MIB / 2), 0.5);
	});

	it('zeigt 1,5 MiB als 1,5 und nicht als 2', () => {
		assert.equal(bytesToMiB(1.5 * MIB), 1.5);
	});

	it('ganze Werte bleiben ganz', () => {
		assert.equal(bytesToMiB(25 * MIB), 25);
		assert.equal(bytesToMiB(4096 * MIB), 4096);
	});

	it('trägt auch die 1-KiB-Untergrenze (kein 0)', () => {
		assert.ok(bytesToMiB(DM_MIN_BYTES) > 0);
	});

	it('ein eingetippter Wert kommt nach dem Rundlauf unverändert zurück', () => {
		for (const eingabe of [0.3, 0.5, 0.75, 1, 2.5, 40]) {
			const bytes = dmSizeToSave(eingabe, 25 * MIB);
			assert.ok(bytes !== undefined, `${eingabe} sollte gesendet werden`);
			assert.equal(bytesToMiB(bytes), eingabe, `Eingabe ${eingabe}`);
		}
	});
});

describe('DM-Dateigröße: was beim Speichern mitgeht', () => {
	it('unberührtes Feld (zeigt den gespeicherten 0,5-Wert) wird nicht gesendet', () => {
		// Der Fall des Fehlers: Dateizahl geändert, Größenfeld nur angezeigt.
		assert.equal(dmSizeToSave(0.5, MIB / 2), undefined);
	});

	it('gerundete Anzeige verändert den gespeicherten Wert nie', () => {
		// 1.000.000 Byte werden als 0,9537 MiB angezeigt, und 0,9537 MiB sind
		// nicht mehr 1.000.000 Byte. Das Feld unverändert stehen zu lassen darf
		// den gespeicherten Wert deshalb nicht durch den Anzeigewert ersetzen.
		const gespeichert = 1_000_000;
		assert.equal(dmSizeToSave(bytesToMiB(gespeichert), gespeichert), undefined);
	});

	it('geänderter Wert wird in Bytes umgerechnet', () => {
		assert.equal(dmSizeToSave(40, 25 * MIB), 40 * MIB);
		assert.equal(dmSizeToSave(0.5, 25 * MIB), MIB / 2);
		assert.equal(dmSizeToSave('2.5', 25 * MIB), 2.5 * MIB);
	});

	it('leeres oder unlesbares Feld heißt nicht ändern', () => {
		assert.equal(dmSizeToSave('', 25 * MIB), undefined);
		assert.equal(dmSizeToSave(null, 25 * MIB), undefined);
		assert.equal(dmSizeToSave(undefined, 25 * MIB), undefined);
		assert.equal(dmSizeToSave(Number.NaN, 25 * MIB), undefined);
	});

	it('nie unter der Untergrenze des Servers', () => {
		assert.equal(dmSizeToSave(0, 25 * MIB), DM_MIN_BYTES);
		assert.equal(dmSizeToSave(-3, 25 * MIB), DM_MIN_BYTES);
	});
});
