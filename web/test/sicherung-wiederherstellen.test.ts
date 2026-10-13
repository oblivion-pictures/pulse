import { test } from 'node:test';
import assert from 'node:assert/strict';

import { leseSicherungKanalSeite, KANAL_ORDNER_MUSTER } from '../src/lib/sicherung/wiederherstellen.ts';
import { ordnerAdapter, SicherungsSpiegel } from '../src/lib/sicherung/spiegel.ts';
import { erzeugeDek } from '../src/lib/sicherung/krypto.ts';
import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { ausWire, grabstein, type AblageNachricht } from '../src/lib/ablage/nutzlast.ts';
import type { SicherungEintrag } from '../src/lib/sicherung/nutzlast.ts';
import type { SicherungLeseStaende } from '../src/lib/sicherung/wiederherstellen.ts';

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

/** Spiegelt `anzahl` Nachrichten (Ids 1001… aufsteigend) in den Kanal-Ordner. */
async function ordnerMit(kanalId: string, anzahl: number, dek = erzeugeDek()) {
	const basis = speicherAdapter();
	const spiegel = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, 'dev-aaaa1111-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	const alle: AblageNachricht[] = [];
	for (let i = 1; i <= anzahl; i++) {
		const id = String(1000 + i);
		alle.push(nachricht(id, `nr-${id}`));
	}
	// In Partien über der Spül-Schwelle — es entstehen mehrere Rahmen-Partien,
	// wie im Live-Betrieb.
	spiegel.aufnehmen(kanalId, alle.slice(0, Math.ceil(anzahl / 2)));
	spiegel.aufnehmen(kanalId, alle.slice(Math.ceil(anzahl / 2)));
	await spiegel.jetztSpuelen();
	spiegel.beenden();
	return { basis, dek };
}

test('KANAL_ORDNER_MUSTER — findet Kanal-Ordner in der Wurzel-Listung', () => {
	assert.equal(KANAL_ORDNER_MUSTER.exec('kanal-42/dev-aaaa1111-seg-000007.puls')![1], 'kanal-42');
	// Der Bindestrich zwischen Kürzel und `seg` fehlt je nach Kürzel-Fassung.
	assert.ok(KANAL_ORDNER_MUSTER.test('kanal-42/dev-428822e8seg-000000.puls'));
	assert.equal(KANAL_ORDNER_MUSTER.exec('key.puls'), null);
	assert.equal(KANAL_ORDNER_MUSTER.exec('anhang-123.puls'), null);
	assert.equal(KANAL_ORDNER_MUSTER.exec('kanal-42/dev-aaaa1111-manifest.puls'), null);
});

test('leerer Ordner: keine Einträge, Lesestand unverändert', async () => {
	const dek = erzeugeDek();
	const seite = await leseSicherungKanalSeite(speicherAdapter(), dek, {}, 50);
	assert.deepEqual(seite.eintraege, []);
	assert.deepEqual(seite.lesestand, {});
	assert.equal(seite.erschoepft, true, 'nichts da — erschöpft ohne jeden Lauf (B10)');
});

test('B10: Erschöpfungs-Kennung — begrenzte Seite nicht, Infinity-Lauf erschöpft den Ordner', async () => {
	const kanalId = 'kanal-a';
	const { basis, dek } = await ordnerMit(kanalId, 120);
	const ordner = ordnerAdapter(basis, kanalId);

	// Endliche Seite: die `anzahl`-Grenze trifft zu — NICHT erschöpft, es
	// bliebe etwas übrig.
	const erste = await leseSicherungKanalSeite(ordner, dek, {}, 50);
	assert.equal(erste.eintraege.length, 50);
	assert.equal(erste.erschoepft, false, 'an der Grenze abgebrochen: Ordner trägt noch');

	// Der Bulk-Weg (`anzahl = Infinity`, EIN Lauf): die Grenze trifft nie
	// zu — der Lauf meldet Erschöpfung selbst, der Aufrufer braucht keinen
	// zweiten Voll-Lauf mehr, der den Ordner nur zur Bestätigung erneut
	// aus dem Drive läde (B10).
	const alles = await leseSicherungKanalSeite(ordner, dek, {}, Infinity);
	assert.equal(alles.eintraege.length, 120, 'ein Lauf, der ganze Ordner');
	assert.equal(alles.erschoepft, true, 'Infinity-Lauf ist stets erschöpft');

	// Danach: erschöpft UND leer — die Kennung und der Inhalt stimmen überein.
	const danach = await leseSicherungKanalSeite(ordner, dek, alles.lesestand, Infinity);
	assert.equal(danach.eintraege.length, 0);
	assert.equal(danach.erschoepft, true);
});

test('Seitenweise rückwärts: 120 Nachrichten in drei Seiten ohne Dublette und Lücke', async () => {
	const kanalId = 'kanal-a';
	const { basis, dek } = await ordnerMit(kanalId, 120);
	const ordner = ordnerAdapter(basis, kanalId);

	const gelesen: SicherungEintrag[] = [];
	let stand: SicherungLeseStaende = {};
	// Eine Seite mehr als nötig — die vierte belegt die Erschöpfung (leer).
	for (let seiteNr = 0; seiteNr < 4; seiteNr++) {
		const seite = await leseSicherungKanalSeite(ordner, dek, stand, 50);
		assert.ok(seite.eintraege.length <= 50, 'Seite hält die Anzahl ein');
		gelesen.push(...seite.eintraege);
		stand = seite.lesestand;
		if (seite.eintraege.length === 0) break;
	}

	assert.equal(gelesen.length, 120, 'alle Nachrichten über drei Seiten');
	// Kein Duplikat.
	assert.equal(new Set(gelesen.map((e) => e.nachricht.id)).size, 120);
	// Erste Seite = die NEUESTEN 50 (größte Ids zuerst), dann die davor,
	// dann der Rest — lückenlos absteigend über die Seiten hinweg.
	assert.deepEqual(
		gelesen.map((e) => Number(e.nachricht.id)),
		Array.from({ length: 120 }, (_, i) => 1120 - i),
	);
});

test('zwei Geräte-Ketten im Ordner: beide gelesen, ohne Dublette, Cursor je Kette', async () => {
	const kanalId = 'kanal-a';
	const basis = speicherAdapter();
	const dek = erzeugeDek();
	const ordner = ordnerAdapter(basis, kanalId);
	// Zwei Geräte spiegeln dasselbe Gespräch — dieselbe Nachricht 100 liegt
	// in BEIDEN Ketten, Gerät 2 hat zusätzlich die 200.
	const eins = new SicherungsSpiegel(ordner, dek, 'dev-aaaa1111-', { verzoegerungMs: 10 });
	const zwei = new SicherungsSpiegel(ordner, dek, 'dev-bbbb2222-', { verzoegerungMs: 10 });
	eins.aufnehmen(kanalId, [nachricht('100', 'erste')]);
	zwei.aufnehmen(kanalId, [nachricht('100', 'erste'), nachricht('200', 'zweite')]);
	await eins.jetztSpuelen();
	await zwei.jetztSpuelen();
	eins.beenden();
	zwei.beenden();

	const erste = await leseSicherungKanalSeite(ordner, dek, {}, 50);
	assert.deepEqual(
		erste.eintraege.map((e) => e.nachricht.inhalt),
		['zweite', 'erste'],
		'neueste zuerst, geräteübergreifend dedupliziert',
	);
	assert.equal(Object.keys(erste.lesestand).length, 2, 'Cursor für beide Ketten');
	const zweite = await leseSicherungKanalSeite(ordner, dek, erste.lesestand, 50);
	assert.deepEqual(zweite.eintraege, [], 'zweiter Lauf: nichts Neues');
});

test('nach einer Seite kommt eine neue Nachricht dazu — der nächste Lauf liefert nur sie', async () => {
	const kanalId = 'kanal-a';
	const basis = speicherAdapter();
	const dek = erzeugeDek();
	const ordner = ordnerAdapter(basis, kanalId);
	const spiegel = new SicherungsSpiegel(ordner, dek, 'dev-aaaa1111-', { verzoegerungMs: 10 });

	spiegel.aufnehmen(kanalId, [nachricht('100', 'erste')]);
	await spiegel.jetztSpuelen();
	const erster = await leseSicherungKanalSeite(ordner, dek, {}, 50);
	assert.deepEqual(erster.eintraege.map((e) => e.nachricht.inhalt), ['erste']);
	const praefix = Object.keys(erster.lesestand)[0]!;
	assert.ok(praefix.startsWith('dev-'), 'Lesestand für die Geräte-Kette');

	// Zweiter Lauf, nichts Neues — leer, ohne dass etwas verloren geht.
	const zweiter = await leseSicherungKanalSeite(ordner, dek, erster.lesestand, 50);
	assert.equal(zweiter.eintraege.length, 0);

	// Neue Nachricht dazwischen: nur sie kommt beim dritten Lauf.
	spiegel.aufnehmen(kanalId, [nachricht('200', 'zweite')]);
	await spiegel.jetztSpuelen();
	const dritter = await leseSicherungKanalSeite(ordner, dek, zweiter.lesestand, 50);
	assert.deepEqual(dritter.eintraege.map((e) => e.nachricht.inhalt), ['zweite']);
	spiegel.beenden();
});

test('beschädigtes Segment — wird übersprungen, Rest der Kette bleibt lesbar', async () => {
	const kanalId = 'kanal-a';
	const { basis, dek } = await ordnerMit(kanalId, 2);
	const ordner = ordnerAdapter(basis, kanalId);
	// Müll im Namensraum desselben Geräts, im Segment DAHINTER (neuer):
	await basis.schreibe('kanal-a/dev-aaaa1111-seg-000009.puls', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));

	const seite = await leseSicherungKanalSeite(ordner, dek, {}, 50);
	assert.deepEqual(
		seite.eintraege.map((e) => e.nachricht.inhalt).sort(),
		['nr-1001', 'nr-1002'],
		'die lesbaren Segmente überleben',
	);
});

test('zwei Geräte spiegeln dieselbe Nachricht — die kryptoId-Verngabelung liefert sie EINMAL', async () => {
	const kanalId = 'kanal-a';
	const dek = erzeugeDek();
	const basis = speicherAdapter();
	// Dasselbe Wort, gespiegelt von ZWEI Geräten: je eigene lokale Id
	// (Empfangs-Id bzw. Autor-Id), dieselbe kanonische `kryptoId`.
	const kopieA = ausWire({
		id: '6001',
		author_id: '100',
		content: 'dasselbe Wort',
		created_at: '2026-09-17T09:00:00Z',
		edited_at: null,
		reply_to_id: null,
		attachments: [],
		krypto_id: '1760000000000000001',
	} as unknown as Parameters<typeof ausWire>[0]);
	const kopieB = { ...kopieA, id: '6002' };
	const spiegelA = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, 'dev-aaaa1111-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	const spiegelB = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, 'dev-bbbb2222-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	spiegelA.aufnehmen(kanalId, [kopieA]);
	spiegelB.aufnehmen(kanalId, [kopieB]);
	await spiegelA.jetztSpuelen();
	await spiegelB.jetztSpuelen();
	spiegelA.beenden();
	spiegelB.beenden();

	const seite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, 50);
	assert.equal(seite.eintraege.length, 1, 'eine logische Nachricht = ein Eintrag');
	assert.equal(seite.eintraege[0]!.nachricht.kryptoId, '1760000000000000001');
});

test('Verfasser-Kette ohne kryptoId + Empfänger-Kette mit kryptoId: EIN Eintrag (Gerätewechsel, 2026-10-11)', async () => {
	// Der Fall der Doppelzeile nach Gerätewechsel und Wiederherstellung: das
	// Gerät des Verfassers spiegelt seine Nachricht unter ihrer eigenen Id
	// (ohne kryptoId — `senden.ts` setzt sie erst seit 2026-10-13, Bestand
	// von davor bleibt so), das Empfängergerät unter der Zustellungs-Id mit
	// der Kennung als kryptoId.
	const kanalId = '779';
	const dek = erzeugeDek();
	const basis = speicherAdapter();
	const verfasser = nachricht('1760000000000123456', 'hallo');
	const empfang = { ...verfasser, id: '120000000000000001', kryptoId: '1760000000000123456' };
	const a = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, 'dev-aaaa1111-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	const b = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, 'dev-bbbb2222-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	a.aufnehmen(kanalId, [verfasser]);
	await a.jetztSpuelen();
	b.aufnehmen(kanalId, [empfang]);
	await b.jetztSpuelen();
	a.beenden();
	b.beenden();
	const seite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, Infinity);
	assert.equal(seite.eintraege.length, 1);
});

// Gegenprüfung 2026-10-12, Fund 1 (Altbestand): seit e27257b0 schrieb eine
// gebundene Löschung ohne lokalen Treffer einen Stein mit der Kennung des
// Lösch-Frames als ID — und die wählt der Absender frei. Der Leser sortierte
// mit `BigInt` und warf: jede Wiederherstellung des Kanals brach ab, der
// Lesestand rückte nie vor. Solche Rahmen liest er jetzt ohne Absturz und
// überspringt sie.
test('Fund 1: ein Stein mit frei gewählter ID bricht den Leser nicht ab und wird übersprungen', async () => {
	const kanalId = 'kanal-a';
	const basis = speicherAdapter();
	const dek = erzeugeDek();
	const spiegel = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, 'dev-aaaa1111-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	spiegel.aufnehmen(kanalId, [
		nachricht('1001', 'vorher'),
		grabstein('x', { autorId: '100', kryptoId: 'x' }),
		{ ...nachricht('1002', 'mit fremden Bezügen'), kryptoId: 'y', antwortAuf: '../z' },
		nachricht('1003', 'nachher'),
	]);
	await spiegel.jetztSpuelen();
	spiegel.beenden();

	const seite = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, Infinity);
	assert.deepEqual(
		seite.eintraege.map((e) => e.nachricht.id),
		['1003', '1002', '1001'],
	);
	// Der Lesestand rückt über den übersprungenen Rahmen hinweg vor.
	const danach = await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, seite.lesestand, Infinity);
	assert.deepEqual(danach.eintraege, []);
	// Eine ungültige Kennung und ein ungültiger Bezug fallen weg, die
	// Nachricht selbst bleibt.
	const fremd = seite.eintraege.find((e) => e.nachricht.id === '1002')!;
	assert.equal(fremd.nachricht.inhalt, 'mit fremden Bezügen');
	assert.equal(fremd.nachricht.kryptoId, undefined);
	assert.equal(fremd.nachricht.antwortAuf, null);
});

/* ————————————————————————————————————————————————————————————————
 * Zwei eigene Geräte spiegeln dieselbe selbst gesendete Nachricht
 * (2026-10-13): das Sendegerät seine Kopie unter der Autor-Id A — bis zu
 * diesem Tag OHNE kryptoId —, das Zweitgerät die Selbstzustellung unter der
 * Zustellungs-Id Z mit kryptoId A.
 * ———————————————————————————————————————————————————————————————— */

const AUTOR_ID = '1791841626624331125';
const ZUSTELLUNG = '103281734567890123';

function kopie(id: string, kryptoId: string | undefined, extra: Partial<AblageNachricht> = {}) {
	return {
		...ausWire({
			id,
			author_id: '100',
			content: 'selbst gesendet',
			created_at: '2026-10-13T09:00:00Z',
			edited_at: null,
			reply_to_id: null,
			attachments: [],
			...(kryptoId ? { krypto_id: kryptoId } : {}),
		} as unknown as Parameters<typeof ausWire>[0]),
		...extra,
	};
}

/** Je Gerät eine Kette im selben Kanal-Ordner, gelesen als eine Seite. */
async function zweiKetten(
	ketten: Array<{ praefix: string; nachrichten: AblageNachricht[] }>,
): Promise<SicherungEintrag[]> {
	const kanalId = 'kanal-a';
	const dek = erzeugeDek();
	const basis = speicherAdapter();
	for (const { praefix, nachrichten } of ketten) {
		const spiegel = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, praefix, {
			verzoegerungMs: 10,
		});
		spiegel.aufnehmen(kanalId, nachrichten);
		await spiegel.jetztSpuelen();
		spiegel.beenden();
	}
	return (await leseSicherungKanalSeite(ordnerAdapter(basis, kanalId), dek, {}, 50)).eintraege;
}

for (const [fall, absenderKryptoId] of [
	['Altbestand ohne kryptoId', undefined],
	['neu mit kryptoId = id', AUTOR_ID],
] as const) {
	// Die Ketten werden in Schreibreihenfolge gelesen (gleicher Segment-
	// Index) — beide Reihenfolgen, weil der Abgleich in beide Richtungen
	// greifen muss.
	for (const senderZuerst of [true, false]) {
		test(`Absender-Kopie (${fall}) + Kopie des Zweitgeräts → EIN Eintrag (${senderZuerst ? 'Sendegerät' : 'Zweitgerät'} zuerst gelesen)`, async () => {
			const sender = { praefix: 'dev-aaaa1111-', nachrichten: [kopie(AUTOR_ID, absenderKryptoId)] };
			const zweit = { praefix: 'dev-bbbb2222-', nachrichten: [kopie(ZUSTELLUNG, AUTOR_ID)] };
			const eintraege = await zweiKetten(senderZuerst ? [sender, zweit] : [zweit, sender]);
			assert.equal(eintraege.length, 1, 'eine logische Nachricht = ein Eintrag');
		});
	}
}

test('drei Kopien aus drei Ketten (Sendegerät im Altbestand, zwei Zweitgeräte) → EIN Eintrag', async () => {
	const eintraege = await zweiKetten([
		{ praefix: 'dev-aaaa1111-', nachrichten: [kopie(AUTOR_ID, undefined)] },
		{ praefix: 'dev-bbbb2222-', nachrichten: [kopie(ZUSTELLUNG, AUTOR_ID)] },
		{ praefix: 'dev-cccc3333-', nachrichten: [kopie('103281734567890999', AUTOR_ID)] },
	]);
	assert.equal(eintraege.length, 1);
});

// Eigentümer-Entscheid 2026-10-13 („sicher: nie über die Kennung"): ein
// Grabstein OHNE Autor löst nie über eine Kennung auf und löscht nur seinen
// eigenen Eintrag. Hier stand bis dahin das Gegenteil (main, 24e9c790: der
// Stein des Sendegeräts verdrängte die Kopie des Zweitgeräts).
//
// Warum: Steine ohne Autor stammen aus der Zeit vor 2026-10-11, und zu
// ihnen gehören die des N1-Rückfalls (`krypto/empfangen.ts`). Der löschte
// auf Lösch-Frames hin, die die Autor-Bindung abgewiesen hatte — ein
// Gesprächspartner, der die Kennung einer meiner Nachrichten in einen
// Lösch-Frame schrieb, hinterliess so in meiner Sicherung einen autorlosen
// Stein unter genau dieser Kennung. Löste der Leser ihn über die Kennung
// auf, nähme jede Wiederherstellung auch die übrigen Kopien der Nachricht
// mit. Was der Entscheid kostet: hat das Zweitgerät die Löschung damals
// nicht selbst als Stein gespiegelt, steht seine Kopie nach der
// Wiederherstellung wieder da.
test('Grabstein des Sendegeräts ohne Autor löscht nur seinen eigenen Eintrag — die Kopie des Zweitgeräts bleibt', async () => {
	const stein: AblageNachricht = {
		...kopie(AUTOR_ID, undefined),
		autor: '',
		inhalt: '',
		geloescht: true,
	};
	const steinKette = { praefix: 'dev-aaaa1111-', nachrichten: [stein] };
	const kopieKette = { praefix: 'dev-bbbb2222-', nachrichten: [kopie(ZUSTELLUNG, AUTOR_ID)] };
	for (const ketten of [[steinKette, kopieKette], [kopieKette, steinKette]]) {
		const eintraege = await zweiKetten(ketten);
		const steine = eintraege.filter((e) => e.nachricht.geloescht === true);
		const sichtbar = eintraege.filter((e) => e.nachricht.geloescht !== true);
		assert.deepEqual(steine.map((e) => e.nachricht.id), [AUTOR_ID], 'der Stein steht nur für sich');
		assert.deepEqual(sichtbar.map((e) => e.nachricht.id), [ZUSTELLUNG], 'die Kopie bleibt sichtbar');
	}
});

test('Leser-Fall: Bobs Nachricht unter Alices Kennung ersetzt Alices nicht, sein Stein löscht sie nicht', async () => {
	// Alices Sendegerät spiegelt ihre Nachricht K, ihr Zweitgerät die
	// Nachricht, die Bob mit derselben Kennung K geschickt hat — samt Anhang,
	// also der „reicheren" Fassung. Ohne Autor-Bindung legte der Leser beide
	// zusammen, Bobs Fassung gewann, und löschte Bob seine, war Alices weg.
	const ALICE = '100';
	const BOB = '300';
	const alices = kopie(AUTOR_ID, AUTOR_ID, { inhalt: 'von alice' });
	const bobs = kopie(ZUSTELLUNG, AUTOR_ID, {
		autor: BOB,
		inhalt: 'von bob',
		anhaenge: [{ id: '501', name: 'b.png', mime: 'image/png', groesse: 3 }],
	});
	const alicesKette = { praefix: 'dev-aaaa1111-', nachrichten: [alices] };
	const bobsStein = grabstein(ZUSTELLUNG, { autorId: BOB, kryptoId: AUTOR_ID });
	for (const geloescht of [false, true]) {
		const bobsKette = {
			praefix: 'dev-bbbb2222-',
			nachrichten: geloescht ? [bobs, bobsStein] : [bobs],
		};
		for (const ketten of [[alicesKette, bobsKette], [bobsKette, alicesKette]]) {
			const eintraege = await zweiKetten(ketten);
			const alice = eintraege.filter((e) => e.nachricht.autor === ALICE);
			assert.equal(alice.length, 1, 'Alices Nachricht steht genau einmal da');
			assert.equal(alice[0]!.nachricht.geloescht, undefined, 'und ist nicht gelöscht');
			assert.equal(alice[0]!.nachricht.inhalt, 'von alice');
			assert.deepEqual(alice[0]!.nachricht.anhaenge, []);
			// Bobs Zeile bleibt eine eigene — gelöscht als Stein je lokaler ID
			// seiner Gruppe (D und die Kennung K, beide mit Bob als Autor).
			const bob = eintraege.filter((e) => e.nachricht.autor === BOB);
			assert.ok(bob.length >= 1);
			assert.ok(bob.every((e) => (e.nachricht.geloescht === true) === geloescht));
		}
	}
});

test('Altbestand ohne jede kryptoId: verschiedene Ids bleiben zwei Einträge', async () => {
	const eintraege = await zweiKetten([
		{ praefix: 'dev-aaaa1111-', nachrichten: [kopie(AUTOR_ID, undefined)] },
		{ praefix: 'dev-bbbb2222-', nachrichten: [kopie(ZUSTELLUNG, undefined)] },
	]);
	assert.equal(eintraege.length, 2);
});
