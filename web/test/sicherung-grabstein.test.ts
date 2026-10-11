import { test } from 'node:test';
import assert from 'node:assert/strict';

import { leseSicherungKanalSeite } from '../src/lib/sicherung/wiederherstellen.ts';
import { ordnerAdapter, ordnerLeeren, SicherungsSpiegel } from '../src/lib/sicherung/spiegel.ts';
import { erzeugeDek } from '../src/lib/sicherung/krypto.ts';
import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import {
	ausWire,
	grabstein,
	kodiereNachricht,
	leseNachricht,
	type AblageNachricht,
} from '../src/lib/ablage/nutzlast.ts';

function nachricht(id: string, inhalt: string): AblageNachricht {
	return ausWire({
		id,
		author_id: '100',
		content: inhalt,
		created_at: '2026-08-31T12:00:00Z',
		edited_at: null,
		reply_to_id: null,
		attachments: [],
	} as unknown as Parameters<typeof ausWire>[0]);
}

/** Spiegelt die Nachrichten als EIN Gerät in den Kanal-Ordner. */
async function gespiegelt(kanalId: string, nachrichten: AblageNachricht[]) {
	const basis = speicherAdapter();
	const dek = erzeugeDek();
	const spiegel = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, 'dev-aaaa1111-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	spiegel.aufnehmen(kanalId, nachrichten);
	await spiegel.jetztSpuelen();
	spiegel.beenden();
	return { basis, dek };
}

test('Grabstein-Nutzlast: Kodierung trägt das Feld, normaler Bestand bleibt byte-identisch', () => {
	const stein = kodiereNachricht(grabstein('100'));
	assert.ok(new TextDecoder().decode(stein).includes('"geloescht":true'));
	assert.equal(leseNachricht(stein).geloescht, true);

	const normal = kodiereNachricht(nachricht('100', 'x'));
	assert.ok(!new TextDecoder().decode(normal).includes('geloescht'), 'Feld bleibt absent');
	assert.equal(leseNachricht(normal).geloescht, undefined);
});

test('(a) Grabstein-Rundlauf: Nachricht + Stein derselben Id — die Seite liefert nur den Stein', async () => {
	const kanalId = 'kanal-a';
	// Die Nachricht MIT Anhang gespiegelt: ohne die Grabstein-Regel im Leser
	// gewänne die "reichere Fassung" und die Löschung wäre weg.
	const mitAnhang = ausWire({
		id: '100',
		author_id: '100',
		content: 'wird gelöscht',
		created_at: '2026-08-31T12:00:00Z',
		edited_at: null,
		reply_to_id: null,
		attachments: [{ id: 'an-1', filename: 'a.png', mime: 'image/png', size: 12, url: 'http://x' }],
	} as unknown as Parameters<typeof ausWire>[0]);
	const { basis, dek } = await gespiegelt(kanalId, [mitAnhang, grabstein('100')]);

	const seite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, 50);
	assert.equal(seite.eintraege.length, 1, 'Id-Dublette zusammengeführt');
	const eintrag = seite.eintraege[0]!;
	assert.equal(eintrag.nachricht.geloescht, true, 'als Gelöscht-Markierung');
	assert.equal(eintrag.nachricht.inhalt, '', 'der Stein trägt keinen Inhalt');
	// Was die Andock-Schicht als "sichtbar" anlegen würde: nichts.
	assert.equal(seite.eintraege.filter((e) => e.nachricht.geloescht !== true).length, 0);
});

test('(b) Grabstein vor Nachricht (Löschung eilt der Zustellung voraus): nichts Sichtbares', async () => {
	const kanalId = 'kanal-b';
	const { basis, dek } = await gespiegelt(kanalId, [grabstein('100')]);

	const seite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, 50);
	assert.equal(seite.eintraege.length, 1);
	assert.equal(seite.eintraege[0]!.nachricht.geloescht, true);
	const sichtbar = seite.eintraege.filter((e) => e.nachricht.geloescht !== true);
	assert.equal(sichtbar.length, 0, 'die Seite legt nichts Sichtbares an');
	// Der Stein ist ein echter Rahmen: der Lesestand zählt ihn, der nächste
	// Lauf liefert nichts erneut.
	const zweite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, seite.lesestand, 50);
	assert.equal(zweite.eintraege.length, 0);
});

test('gemischte Seite: Grabstein und normale Nachricht laufen getrennt korrekt', async () => {
	const kanalId = 'kanal-c';
	const { basis, dek } = await gespiegelt(kanalId, [
		nachricht('100', 'bleibt'),
		grabstein('100'),
		nachricht('200', 'auch da'),
		grabstein('300'),
	]);

	const seite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, 50);
	assert.deepEqual(
		seite.eintraege.map((e) => [e.nachricht.id, e.nachricht.geloescht === true]),
		[['300', true], ['200', false], ['100', true]],
		'Stein gewinnt gegen Nachricht derselben Id, Rest bleibt sichtbar',
	);
});

test('(c) Ordner-Löschung: nach dem Leeren listet der Basis-Adapter keine Datei des Kanals mehr', async () => {
	const kanalId = 'kanal-x';
	const { basis, dek } = await gespiegelt(kanalId, [nachricht('100', 'x')]);
	// Fremdes bleibt stehen: Schlüssel-Datei im Wurzel-Ordner, anderer Kanal.
	await basis.schreibe('key.puls', new Uint8Array([1]));
	await basis.schreibe('kanal-y/dev-aaaa1111-seg-000000.puls', new Uint8Array([2]));
	assert.ok((await basis.liste()).some((n) => n.startsWith('kanal-x/')));

	// Dieselbe Rechnung wie `sicherungGespraechEntfernen` (andock.ts) — das
	// Modul selbst lädt der Node-Läufer nicht (transitiv IndexedDB/Svelte),
	// die Ordner-Rechnung liegt deshalb importfrei in spiegel.ts.
	await ordnerLeeren(ordnerAdapter(basis, kanalId));

	const rest = await basis.liste();
	assert.equal(rest.some((n) => n.startsWith('kanal-x/')), false, 'Kanal-Ordner leer');
	assert.ok(rest.includes('key.puls'), 'Schlüssel-Datei bleibt');
	assert.ok(rest.includes('kanal-y/dev-aaaa1111-seg-000000.puls'), 'fremder Kanal bleibt');
	assert.ok(dek.length > 0);
});

// ── Grabstein mit Autor und Kennung (Befund N3, 2026-10-11) ─────────────────
// Ein Stein auf die Zustellungs-ID D traf die Archiv-Kopie desselben Worts
// (lokale ID K) nie; jetzt trägt er Autor und Kennung des gelöschten Satzes.

const K = '1760000000000123456';
const D = '120000000000000001';

/** Die Nachricht unter der lokalen ID K, von `autorId`, auf Wunsch mit
 *  Kennung (`krypto_id`). */
function nachrichtK(autorId: string, inhalt: string, kryptoId?: string): AblageNachricht {
	return ausWire({
		id: K,
		author_id: autorId,
		content: inhalt,
		created_at: '2026-10-10T10:00:00Z',
		edited_at: null,
		reply_to_id: null,
		attachments: [],
		krypto_id: kryptoId,
	} as unknown as Parameters<typeof ausWire>[0]);
}

test('N3: der Stein trägt Autor und Kennung durch Kodieren und Lesen — ohne Satz bleibt er alt', () => {
	const neu = leseNachricht(kodiereNachricht(grabstein(D, { autorId: '200', kryptoId: K })));
	assert.equal(neu.geloescht, true);
	assert.equal(neu.autor, '200');
	assert.equal(neu.kryptoId, K);
	assert.equal(neu.inhalt, '');
	// Beim Verfasser hat der Satz keine kryptoId — seine ID IST die Kennung.
	assert.equal(grabstein(K, { autorId: '200', kryptoId: null }).kryptoId, K);
	const alt = grabstein(D);
	assert.equal(alt.autor, '');
	assert.ok(!('kryptoId' in alt), 'ohne lokalen Satz: dieselbe Form wie vor der Erweiterung');
});

test('N3: ein Stein mit Autor trifft die Verfasser-/Archiv-Kopie K, auch ohne den Rahmen D', async () => {
	const kanalId = 'kanal-n3';
	const kopieK = nachrichtK('200', 'gelöscht', K);
	const { basis, dek } = await gespiegelt(kanalId, [kopieK, grabstein(D, { autorId: '200', kryptoId: K })]);
	const seite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, 50);
	assert.equal(seite.eintraege.filter((e) => e.nachricht.geloescht !== true).length, 0);
	assert.deepEqual(seite.eintraege.map((e) => e.nachricht.id).sort(), [D, K].sort());
});

test('N3: ein Stein mit fremdem Autor trifft die Kopie K nicht', async () => {
	// Bob löscht seine eigene Nachricht, die Alices Kennung K trug — Alices
	// Nachricht K bleibt stehen.
	const kanalId = 'kanal-n3b';
	const vonAlice = nachrichtK('200', 'bleibt');
	const { basis, dek } = await gespiegelt(kanalId, [vonAlice, grabstein(D, { autorId: '300', kryptoId: K })]);
	const seite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, 50);
	assert.deepEqual(
		seite.eintraege.filter((e) => e.nachricht.geloescht !== true).map((e) => e.nachricht.inhalt),
		['bleibt'],
	);
});
