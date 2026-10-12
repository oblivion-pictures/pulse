import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	DEFAULT_ATTACH_MAX_COUNT,
	DEFAULT_ATTACH_MAX_SIZE_BYTES,
	bytesToUnit,
	bytesToUnitStr,
	ceilingOrDefault,
	unitStrToBytes,
	unitStrToBytesKeep
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

describe('Betreiber-Formular: unverändertes Feld behält den gespeicherten Wert', () => {
	const GB = 1024 * 1024 * 1024;

	it('1.000.000 Byte werden nicht über die gerundete Anzeige zu 996.147', () => {
		// Anzeige: "0.95". Ohne Keep ergäbe die Rückrechnung 996147.
		assert.equal(bytesToUnitStr(1_000_000, MB), '0.95');
		assert.equal(unitStrToBytes('0.95', MB), 996147);
		assert.equal(unitStrToBytesKeep('0.95', 1_000_000, MB), 1_000_000);
		assert.equal(unitStrToBytesKeep(0.95, 1_000_000, MB), 1_000_000); // bind:value liefert eine Zahl
	});

	it('gilt auch für GB (Gesamt-Speicher, Ablage)', () => {
		const gespeichert = 5_000_000_000; // 4.66 GB angezeigt
		assert.equal(unitStrToBytesKeep(bytesToUnitStr(gespeichert, GB), gespeichert, GB), gespeichert);
	});

	it('ein geänderter Wert wird umgerechnet', () => {
		assert.equal(unitStrToBytesKeep('50', 1_000_000, MB), 50 * MB);
		assert.equal(unitStrToBytesKeep('2.5', null, GB), 2.5 * GB);
	});

	it('leer bleibt null, auch wenn vorher etwas gespeichert war (löscht / nicht ändern entscheidet der Server)', () => {
		assert.equal(unitStrToBytesKeep('', 50 * MB, MB), null);
		assert.equal(unitStrToBytesKeep('', null, MB), null);
	});

	it('Zurücktippen auf den alten Wert nach einem Speichern wirkt', () => {
		// Server steht jetzt auf 50 MB; das Feld zeigt wieder die alten "25".
		assert.equal(unitStrToBytesKeep('25', 50 * MB, MB), 25 * MB);
	});
});
