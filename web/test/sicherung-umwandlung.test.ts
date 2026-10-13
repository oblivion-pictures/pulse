import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ausSatz, ausWire, NUTZLAST_FASSUNG } from '../src/lib/ablage/nutzlast.ts';
import type { Message } from '../src/lib/api/types.ts';
import {
	kodiereSicherungEintrag,
	leseSicherungEintrag,
	sicherungEintrag,
	zuWire,
} from '../src/lib/sicherung/nutzlast.ts';
import { zuSatz } from '../src/lib/verlauf/satz.ts';
import { nachrichtIdentitaet } from '../src/lib/verlauf/identitaet.ts';
import { EintragsGruppen } from '../src/lib/sicherung/eintragsGruppen.ts';
import type { Satz } from '../src/lib/verlauf/schema.ts';

// Die Erstsicherung baute die Bestand-Form bis 2026-10-11 von Hand nach und
// ließ die kryptoId weg (Befund M1). Hier läuft ein Satz den ganzen Weg:
// Satz → Bestand-Form → Rahmen-Bytes → zurück → Satz.

const K = '1760000000000123456';
const D = '120000000000000001';

function empfangsSatz() {
	const satz = zuSatz(
		'777',
		{
			id: D,
			author_id: '200',
			content: 'hallo',
			created_at: '2026-10-10T10:00:00Z',
			edited_at: null,
			reply_to_id: null,
			krypto_id: K,
			verschluesselt: true,
			attachments: [{ id: '501', filename: 'f.png', mime: 'image/png', size: 3, schluessel: 'geheim' }],
		},
		'konto-a',
	);
	assert.ok(satz);
	return satz;
}

test('M1: Satz → Sicherung → Satz behält kryptoId, Identität und den Dateischlüssel', () => {
	const vorher = empfangsSatz();
	const bytes = kodiereSicherungEintrag(sicherungEintrag('777', ausSatz(vorher)));
	const gelesen = leseSicherungEintrag(bytes);
	const nachher = zuSatz(gelesen.kanalId, zuWire(gelesen.nachricht), 'konto-a');
	assert.ok(nachher);
	assert.equal(nachher.nachrichtId, D);
	assert.equal(nachher.kryptoId, K);
	assert.equal(
		nachrichtIdentitaet(nachher.autorId, nachher.nachrichtId, nachher.kryptoId),
		nachrichtIdentitaet(vorher.autorId, vorher.nachrichtId, vorher.kryptoId),
	);
	const anhang = nachher.anhaenge[0] as Record<string, unknown>;
	assert.equal(anhang.schluessel, 'geheim', 'ohne den Schlüssel bliebe der Anhang zu');
	assert.equal(anhang.filename, 'f.png');
});

test('M1: ausSatz und ausWire liefern für dieselbe Nachricht dieselbe Bestand-Form', () => {
	const satz = empfangsSatz();
	const vomWire = ausWire({
		id: D,
		channel_id: '777',
		author_id: '200',
		content: 'hallo',
		nonce: null,
		created_at: '2026-10-10T10:00:00Z',
		edited_at: null,
		reply_to_id: null,
		krypto_id: K,
		attachments: [{ id: '501', filename: 'f.png', mime: 'image/png', size: 3, schluessel: 'geheim' }],
	} as unknown as Message);
	assert.deepEqual(ausSatz(satz), vomWire);
});

test('M1: Erstsicherung einer Archiv-Kopie und Spiegel des Altgeräts werden EIN Eintrag', () => {
	// Archiv-Kopie {K, kryptoId K} auf dem Frischgerät, Empfangs-Kopie {D, K}
	// aus der Kette des Altgeräts.
	const archiv = zuSatz('777', { ...zuWire(ausSatz(empfangsSatz())), id: K }, 'konto-a');
	assert.ok(archiv);
	const gruppen = new EintragsGruppen();
	gruppen.aufnehmen(sicherungEintrag('777', ausSatz(empfangsSatz())));
	gruppen.aufnehmen(sicherungEintrag('777', ausSatz(archiv)));
	assert.equal(gruppen.ergebnis().length, 1);
});

test('ausSatz verträgt Altbestand: fehlende Anhang-Felder werden aufgefüllt, Fremdes fällt raus', () => {
	const satz = { ...empfangsSatz(), anhaenge: [{ id: '502' }, null, 'kaputt'] };
	const bytes = kodiereSicherungEintrag(sicherungEintrag('777', ausSatz(satz)));
	// Ohne Auffüllen wiese der strenge Leser den ganzen Rahmen ab.
	const gelesen = leseSicherungEintrag(bytes);
	assert.deepEqual(
		gelesen.nachricht.anhaenge.map((a) => [a.id, a.name, a.groesse]),
		[['502', null, 0]],
	);
});

// Übernommen aus `sicherung-satz-nutzlast.test.ts` (main, 8b4a996d): dort
// liefen dieselben drei Fälle gegen eine zweite Umwandlung Satz → Bestand,
// die neben `ausSatz` entstanden war. Es gibt nur noch `ausSatz`; die Fälle
// gelten für sie unverändert, dazu fallen die flüchtigen Adressen weg.

function archivSatz(teil: Partial<Satz> = {}): Satz {
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
	const nachricht = ausSatz(archivSatz({ kryptoId: '1791841626624331125' }));
	assert.equal(nachricht.kryptoId, '1791841626624331125');

	const eintrag = sicherungEintrag('103247075621216256', nachricht);
	const zurueck = leseSicherungEintrag(kodiereSicherungEintrag(eintrag));
	assert.equal(zurueck.nachricht.kryptoId, '1791841626624331125');
});

test('ohne kryptoId im Satz bleibt das Feld im Eintrag weg', () => {
	const nachricht = ausSatz(archivSatz({ kryptoId: null }));
	assert.equal('kryptoId' in nachricht, false);
});

test('die übrigen Felder werden übernommen, flüchtige Adressen der Anhänge nicht', () => {
	const nachricht = ausSatz(
		archivSatz({
			bearbeitetAm: '2026-10-12T21:50:00.000Z',
			antwortAufId: '555',
			anhaenge: [
				{ id: 7, filename: 'a.png', mime: 'image/png', size: 12, url: 'blob:x', thumb_url: 'blob:y' },
			],
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
