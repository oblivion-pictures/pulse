import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	kodiereSicherungEintrag,
	leseSicherungEintrag,
	satzZuAblageNachricht,
	sicherungEintrag,
} from '../src/lib/sicherung/nutzlast.ts';
import { NUTZLAST_FASSUNG } from '../src/lib/ablage/nutzlast.ts';
import type { Satz } from '../src/lib/verlauf/schema.ts';

/**
 * Die Erstsicherung holt den lokalen Bestand nach — sie baut ihre Einträge aus
 * Verlaufs-Sätzen statt aus Wire-Nachrichten. Die Umwandlung hatte das
 * Merkmal `kryptoId` vergessen: auf einem Frischgerät mit Zeilen aus dem
 * Server-Archiv (dort `krypto_id` = eigene Id) wanderten sie ohne Merkmal in
 * die Sicherung, kamen ohne Merkmal zurück, und dieselbe Nachricht stand
 * doppelt im Kanal (e2e `sicherung-geraetewechsel`, `overnight-sicherung`).
 */

function satz(teil: Partial<Satz> = {}): Satz {
	return {
		schluessel: 'k:1791841626624331125',
		kanalId: '103247075621216256',
		nachrichtId: '1791841626624331125',
		autorId: '103247050000000001',
		inhalt: 'vom anderen rechner angekommen',
		erstelltAm: '2026-10-12T21:47:06.652Z',
		bearbeitetAm: null,
		geloescht: false,
		verschluesselt: true,
		anhaenge: [],
		antwortAufId: null,
		kryptoId: null,
		kontoId: '103247050000000002',
		...teil,
	};
}

test('kryptoId des Satzes reist in den Sicherungs-Eintrag und überlebt Kodieren/Lesen', () => {
	const nachricht = satzZuAblageNachricht(satz({ kryptoId: '1791841626624331125' }));
	assert.equal(nachricht.kryptoId, '1791841626624331125');

	const eintrag = sicherungEintrag('103247075621216256', nachricht);
	const zurueck = leseSicherungEintrag(kodiereSicherungEintrag(eintrag));
	assert.equal(zurueck.nachricht.kryptoId, '1791841626624331125');
});

test('ohne kryptoId im Satz bleibt das Feld im Eintrag weg', () => {
	const nachricht = satzZuAblageNachricht(satz({ kryptoId: null }));
	assert.equal('kryptoId' in nachricht, false);
});

test('die übrigen Felder werden unverändert übernommen', () => {
	const nachricht = satzZuAblageNachricht(
		satz({
			bearbeitetAm: '2026-10-12T21:50:00.000Z',
			antwortAufId: '555',
			anhaenge: [{ id: 7, filename: 'a.png', mime: 'image/png', size: 12 }],
		}),
	);
	assert.equal(nachricht.fassung, NUTZLAST_FASSUNG);
	assert.equal(nachricht.id, '1791841626624331125');
	assert.equal(nachricht.autor, '103247050000000001');
	assert.equal(nachricht.inhalt, 'vom anderen rechner angekommen');
	assert.equal(nachricht.zeit, '2026-10-12T21:47:06.652Z');
	assert.equal(nachricht.bearbeitet, '2026-10-12T21:50:00.000Z');
	assert.equal(nachricht.antwortAuf, '555');
	assert.deepEqual(nachricht.anhaenge, [
		{ id: '7', filename: 'a.png', mime: 'image/png', size: 12, name: 'a.png', groesse: 12 },
	]);
});
