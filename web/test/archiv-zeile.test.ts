/**
 * Rundtrip der Archiv-Zeile (Gruppen-Erweiterung 2026-10-05): Bauen und
 * Lesen des Klartext-Kerns — Text, Threading, Absender und die
 * Anhang-ANGABEN (die Bytes bleiben Durchlauferhitzer; ein anderes Gerät
 * rendert daraus die Kachel, s. Entscheidung 2026-10-05). Läuft im
 * Node-Testläufer, deshalb importfrei bis auf Typen + die Übersetzer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	baueGrabsteinKlar,
	baueZeilenKlar,
	leseZeile,
	leseZeilenKlar
} from '../src/lib/archiv/zeile.ts';
import { zuSatz } from '../src/lib/verlauf/satz.ts';
import type { Message } from '../src/lib/api/types';

function nachricht(mit: Partial<Message> = {}): Message {
	return {
		id: '1234567890123',
		channel_id: '999',
		author_id: '42',
		content: 'Hallo Archiv',
		nonce: null,
		reply_to_id: null,
		created_at: '2026-10-05T10:00:00.000Z',
		verschluesselt: true,
		...mit
	};
}

describe('archiv/zeile', () => {
	test('Rundtrip ohne Anhang und ohne Antwort', () => {
		const klar = baueZeilenKlar(nachricht());
		const zurueck = leseZeilenKlar('999', new TextDecoder().decode(klar));
		assert.equal(zurueck.id, '1234567890123');
		assert.equal(zurueck.content, 'Hallo Archiv');
		assert.equal(zurueck.author_id, '42');
		assert.equal(zurueck.created_at, '2026-10-05T10:00:00.000Z');
		assert.equal(zurueck.reply_to_id, null);
		assert.equal(zurueck.attachments, undefined);
	});

	test('Rundtrip mit Antwort und Anhang-Angaben (Schlüssel, Maße, Vorschau, Dauer)', () => {
		const quelle = nachricht({
			reply_to_id: '777',
			attachments: [
				{
					id: 'anhang-1',
					filename: 'foto.jpg',
					mime: 'image/jpeg',
					size: 1234,
					width: 640,
					height: 480,
					thumb_width: 320,
					thumb_height: 240,
					url: '',
					thumb_url: null,
					verschluesselt: true,
					schluessel: 'a2V5MQ==',
					thumb_schluessel: 'a2V5Mg=='
				},
				{
					id: 'anhang-2',
					filename: null,
					mime: null,
					size: 5,
					url: '',
					thumb_url: null,
					verschluesselt: true,
					schluessel: 'a2V5Mw=='
				}
			]
		});
		const zurueck = leseZeilenKlar('999', new TextDecoder().decode(baueZeilenKlar(quelle)));
		assert.equal(zurueck.reply_to_id, '777');
		assert.equal(zurueck.attachments?.length, 2);
		const eins = zurueck.attachments![0];
		assert.equal(eins.id, 'anhang-1');
		assert.equal(eins.filename, 'foto.jpg');
		assert.equal(eins.mime, 'image/jpeg');
		assert.equal(eins.size, 1234);
		assert.equal(eins.width, 640);
		assert.equal(eins.schluessel, 'a2V5MQ==');
		assert.equal(eins.thumb_schluessel, 'a2V5Mg==');
		assert.equal(eins.thumb_width, 320);
		// Ohne Maße/Schlüssel-Abkömmlinge: schlichter Satz, keine Erfindungen.
		const zwei = zurueck.attachments![1];
		assert.equal(zwei.filename, '');
		assert.equal(zwei.mime, 'application/octet-stream');
		assert.equal(zwei.width, null);
	});

	test('Legacy-Zeile ohne anh-Feld bleibt lesbar (Fassung vor 2026-10-05)', () => {
		const zurueck = leseZeilenKlar(
			'999',
			'{"i":"1","t":"alt","a":"42","z":"2026-10-04T00:00:00.000Z","v":2}'
		);
		assert.equal(zurueck.content, 'alt');
		assert.equal(zurueck.attachments, undefined);
	});

	// ── Einlieferer (Gegenprüfung 2026-10-12, Fund 2) ──────────────────────
	// Den Autor `a` schreibt der Einliefernde selbst in die Nutzlast, und
	// einliefern darf jedes Kanalmitglied. Der Server nennt deshalb seit
	// Migration 0102 den Einlieferer jeder Zeile.

	const klar = (n: Message) => new TextDecoder().decode(baueZeilenKlar(n));

	test('eine Zeile ihres Autors wird angenommen', () => {
		const eintrag = leseZeile('999', klar(nachricht()), '42');
		assert.equal(eintrag?.art, 'nachricht');
		assert.equal(eintrag?.art === 'nachricht' && eintrag.nachricht.content, 'Hallo Archiv');
	});

	test('eine Zeile im Namen eines anderen wird verworfen', () => {
		// Bob (7) liefert eine Zeile mit Alices Namen (42) und ihrer Kennung ein.
		const gefaelscht = klar(nachricht({ content: 'gefälscht' }));
		assert.equal(leseZeile('999', gefaelscht, '7'), null);
	});

	test('eine Bestandszeile ohne Einlieferer wird übergangsweise angenommen', () => {
		assert.equal(leseZeile('999', klar(nachricht()), null)?.art, 'nachricht');
	});

	test('eine Grabstein-Zeile zählt nur von ihrem Autor', () => {
		const stein = new TextDecoder().decode(
			baueGrabsteinKlar('1234567890123', '42', '2026-10-12T00:00:00.000Z')
		);
		assert.deepEqual(leseZeile('999', stein, '42'), {
			art: 'grabstein',
			autorId: '42',
			kennung: '1234567890123'
		});
		// Im Namen eines anderen: verworfen — sonst löschte Bob Alices Nachricht
		// auf jedem Gerät, das das Archiv liest.
		assert.equal(leseZeile('999', stein, '7'), null);
		// Ohne Einlieferer gibt es keinen Grabstein: den Bestand kennt niemand.
		assert.equal(leseZeile('999', stein, null), null);
	});

	test('eine Grabstein-Zeile ist für einen älteren Klienten keine Nachricht', () => {
		// Ältere Klienten kennen `g` nicht und lesen die Zeile als Nachricht;
		// ohne `i` und `t` verwirft `zuSatz` sie still, statt eine leere
		// Nachricht anzulegen.
		const stein = new TextDecoder().decode(baueGrabsteinKlar('1', '42', '2026-10-12T00:00:00.000Z'));
		assert.equal(zuSatz('999', leseZeilenKlar('999', stein), 'konto'), null);
	});

	// ── Kennungen (Gegenprüfung 2026-10-12, Fund 1) ────────────────────────
	// `i`, `g`, `r`, `a` und die Anhang-IDs wählt der Einliefernde frei. Eine
	// Grabstein-Zeile `{g:"x"}` landete bis dahin im Grabstein-Register und
	// als Stein in der Sicherung, deren Leser daran abbrach.

	test('Fund 1: eine Grabstein-Zeile mit ungültiger Kennung wird verworfen', () => {
		for (const kennung of ['x', '', '0123', '1'.repeat(21), '12 ']) {
			const stein = new TextDecoder().decode(
				baueGrabsteinKlar(kennung, '42', '2026-10-12T00:00:00.000Z')
			);
			assert.equal(leseZeile('999', stein, '42'), null, kennung);
		}
		// Ebenso eine `g`, die gar keine Zeichenkette ist.
		assert.equal(leseZeile('999', '{"g":7,"a":"42","z":"2026-10-12T00:00:00.000Z"}', '42'), null);
	});

	test('Fund 1: eine Zeile mit ungültiger ID oder ungültigem Autor wird verworfen', () => {
		assert.equal(leseZeile('999', klar(nachricht({ id: 'x' })), '42'), null);
		assert.equal(leseZeile('999', klar(nachricht({ id: 'x' })), null), null);
		// Eine Bestandszeile nennt ihren Autor selbst — auch er muss eine
		// Konto-ID sein.
		assert.equal(leseZeile('999', klar(nachricht({ author_id: 'alice' })), null), null);
	});

	test('Fund 1: ungültiger Antwortbezug und ungültige Anhang-IDs fallen weg, der Text bleibt', () => {
		const roh = JSON.stringify({
			i: '1234567890123',
			t: 'mit Bezug',
			a: '42',
			z: '2026-10-05T10:00:00.000Z',
			r: 'x',
			anh: [
				{ id: '../datei', name: 'a', typ: 'image/png', groesse: 1, schluessel: 's' },
				{ id: '8', name: 'b', typ: 'image/png', groesse: 1, schluessel: 's' }
			]
		});
		const eintrag = leseZeile('999', roh, '42');
		assert.equal(eintrag?.art, 'nachricht');
		const nachricht = eintrag?.art === 'nachricht' ? eintrag.nachricht : null;
		assert.equal(nachricht?.content, 'mit Bezug');
		assert.equal(nachricht?.reply_to_id, null);
		assert.deepEqual(
			nachricht?.attachments?.map((a) => a.id),
			['8']
		);
	});

	test('Fund 4: eine Bestandszeile ohne Einlieferer trägt die Marke „ungeprüft", eine geprüfte nicht', () => {
		const bestand = leseZeile('999', klar(nachricht()), null);
		assert.equal(bestand?.art === 'nachricht' && bestand.nachricht.archiv_ungeprueft, true);
		assert.equal(
			bestand?.art === 'nachricht' ? zuSatz('999', bestand.nachricht, 'konto')?.ungeprueft : null,
			true
		);
		const geprueft = leseZeile('999', klar(nachricht()), '42');
		assert.equal(geprueft?.art === 'nachricht' && 'archiv_ungeprueft' in geprueft.nachricht, false);
	});
});
