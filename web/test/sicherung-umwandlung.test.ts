import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ausSatz, ausWire } from '../src/lib/ablage/nutzlast.ts';
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
