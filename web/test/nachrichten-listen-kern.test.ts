import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	einfuegen,
	einsortieren,
	ersetzeNachricht,
	kappen,
	kryptoIdsVon,
	letzteServerId,
	lueckeZusammenfuehren,
	vorneAnfuegen
} from '../src/lib/nachrichten/listenKern.ts';
import type { Message } from '../src/lib/api/types.ts';

const msg = (id: string, over: Partial<Message> = {}): Message => ({
	id,
	channel_id: 'k1',
	author_id: 'a',
	content: `inhalt ${id}`,
	nonce: null,
	created_at: '2026-01-01T00:00:00Z',
	...over
});
const ids = (l: Message[]) => l.map((m) => m.id);

describe('Nachrichtenliste: kappen / einsortieren / ersetzen', () => {
	it('kappen lässt eine kurze Liste unangetastet (dieselbe Referenz)', () => {
		const l = [msg('1'), msg('2')];
		const r = kappen(l, 2);
		assert.equal(r.liste, l);
		assert.deepEqual(r.verworfen, []);
	});

	it('kappen behält die neuesten und meldet die ältesten als verworfen', () => {
		const r = kappen([msg('1'), msg('2'), msg('3'), msg('4')], 3);
		assert.deepEqual(ids(r.liste), ['2', '3', '4']);
		assert.deepEqual(ids(r.verworfen), ['1']);
	});

	it('einsortieren hängt Neueres an und sortiert Älteres an die richtige Stelle', () => {
		const l = [msg('100000000000000010'), msg('100000000000000030')];
		assert.deepEqual(
			ids(einsortieren(l, msg('100000000000000040'))),
			['100000000000000010', '100000000000000030', '100000000000000040']
		);
		assert.deepEqual(
			ids(einsortieren(l, msg('100000000000000020'))),
			['100000000000000010', '100000000000000020', '100000000000000030']
		);
		assert.deepEqual(ids(einsortieren([], msg('5'))), ['5']);
		assert.equal(l.length, 2, 'die Eingabeliste bleibt unverändert');
	});

	it('ersetzeNachricht: nicht vorhanden oder „nichts zu tun“ ergibt null, sonst eine Kopie', () => {
		const l = [msg('1'), msg('2')];
		assert.equal(ersetzeNachricht(l, '9', (a) => a), null);
		assert.equal(ersetzeNachricht(l, '1', () => null), null);
		const r = ersetzeNachricht(l, '2', (a) => ({ ...a, content: 'neu' }));
		assert.ok(r && r !== l);
		assert.equal(r[1].content, 'neu');
		assert.equal(r[0], l[0]);
		assert.equal(l[1].content, 'inhalt 2', 'die Eingabeliste bleibt unverändert');
	});

	it('kryptoIdsVon sammelt nur vorhandene krypto_ids', () => {
		const s = kryptoIdsVon([msg('1', { krypto_id: 'k' }), msg('2'), msg('3', { krypto_id: 'k' })]);
		assert.deepEqual([...s], ['k']);
	});
});

describe('Nachrichtenliste: Cursor für das Lückenfüllen', () => {
	it('nimmt die neueste Id, die als BIGINT passt', () => {
		assert.equal(letzteServerId([msg('100000000000000001'), msg('100000000000000002')]), '100000000000000002');
	});

	it('überspringt tmp-Kopien, 20-stellige und über-BIGINT-Ids', () => {
		const l = [
			msg('100000000000000001'),
			msg('9223372036854775808'), // 19 Stellen, aber über int64
			msg('17900000000000000000'), // 20 Stellen
			msg('tmp-1')
		];
		assert.equal(letzteServerId(l), '100000000000000001');
		assert.equal(letzteServerId([msg('tmp-1')]), null);
		assert.equal(letzteServerId([]), null);
	});

	it('eine 19-stellige Id unter der int64-Grenze zählt (so verhielt sich der Store schon)', () => {
		assert.equal(letzteServerId([msg('1790000000000000001')]), '1790000000000000001');
	});
});

describe('Nachrichtenliste: Lücke zusammenführen', () => {
	it('liefert null, wenn alles schon bekannt ist', () => {
		const l = [msg('10')];
		assert.equal(lueckeZusammenfuehren(l, new Set(['10']), [msg('10')], 100), null);
	});

	it('hängt Neues an, sortiert und lässt Bekanntes aus', () => {
		const l = [msg('10'), msg('20')];
		const r = lueckeZusammenfuehren(l, new Set(['10', '20']), [msg('40'), msg('30'), msg('20')], 100);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['10', '20', '30', '40']);
		assert.deepEqual(r.bestaetigteNonces, []);
	});

	it('ersetzt die tmp-Kopie an Ort und Stelle, wenn die echte Zeile ihre Nonce trägt', () => {
		const l = [msg('10'), msg('tmp-5', { nonce: 'n' })];
		const r = lueckeZusammenfuehren(l, new Set(['10', 'tmp-5']), [msg('30', { nonce: 'n' })], 100);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['10', '30']);
		assert.deepEqual(r.bestaetigteNonces, ['n']);
	});

	it('kappt auf cap und meldet die weggefallenen', () => {
		const r = lueckeZusammenfuehren([msg('10'), msg('20')], new Set(['10', '20']), [msg('30'), msg('40')], 3);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['20', '30', '40']);
		assert.deepEqual(ids(r.verworfen), ['10']);
	});
});

describe('Nachrichtenliste: Historie vorn anfügen', () => {
	it('stellt das Neue id-sortiert voran und schreibt die Mengen fort', () => {
		const l = [msg('30')];
		const i = new Set(['30']);
		const k = new Set<string>();
		const r = vorneAnfuegen(l, i, k, [msg('20', { krypto_id: 'x' }), msg('10')], 100);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['10', '20', '30']);
		assert.deepEqual(ids(r.neu), ['10', '20']);
		assert.deepEqual([...i].sort(), ['10', '20', '30']);
		assert.deepEqual([...k], ['x']);
	});

	it('die kanonische Id blockt die Archiv-Kopie mit fremder lokaler Id', () => {
		// Live empfangen: id=Zustellungs-Id, krypto_id=kanonisch. Die Archiv-Kopie
		// trägt die kanonische Id als `id`.
		const l = [msg('30', { krypto_id: '15' })];
		const r = vorneAnfuegen(l, new Set(['30']), new Set(['15']), [msg('15')], 100);
		assert.equal(r, null);
	});

	it('liefert null, wenn nichts Neues dabei war, und lässt die Mengen unberührt', () => {
		const i = new Set(['30']);
		assert.equal(vorneAnfuegen([msg('30')], i, new Set(), [msg('30')], 100), null);
		assert.deepEqual([...i], ['30']);
	});

	it('baut beide Mengen aus der gekappten Liste neu auf', () => {
		const l = [msg('30', { krypto_id: 'k30' })];
		const i = new Set(['30']);
		const k = new Set(['k30']);
		const r = vorneAnfuegen(l, i, k, [msg('10', { krypto_id: 'k10' }), msg('20', { krypto_id: 'k20' })], 2);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['20', '30']);
		assert.deepEqual(ids(r.verworfen), ['10']);
		assert.deepEqual([...i].sort(), ['20', '30']);
		assert.deepEqual([...k].sort(), ['k20', 'k30']);
	});
});

describe('Nachrichtenliste: einzelne Nachricht aufnehmen', () => {
	it('nimmt eine neue Nachricht auf und bucht Id und krypto_id', () => {
		const i = new Set<string>();
		const k = new Set<string>();
		const r = einfuegen([], i, k, msg('10', { krypto_id: 'x' }), 100);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['10']);
		assert.deepEqual([...i], ['10']);
		assert.deepEqual([...k], ['x']);
	});

	it('weist ein Duplikat über die Id UND über die kanonische Id ab', () => {
		const l = [msg('10', { krypto_id: 'x' })];
		assert.equal(einfuegen(l, new Set(['10']), new Set(['x']), msg('10'), 100), null);
		assert.equal(einfuegen(l, new Set(['10']), new Set(['x']), msg('99', { krypto_id: 'x' }), 100), null);
		// Die Gegenrichtung: die kanonische Id der bekannten Kopie ist die neue `id`.
		assert.equal(einfuegen(l, new Set(['10']), new Set(['x']), msg('x'), 100), null);
	});

	it('kappt und baut die Id-Menge neu auf', () => {
		const i = new Set(['10', '20']);
		const r = einfuegen([msg('10'), msg('20')], i, new Set(), msg('30'), 2);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['20', '30']);
		assert.deepEqual(ids(r.verworfen), ['10']);
		assert.deepEqual([...i].sort(), ['20', '30']);
	});

	it('lässt die krypto-Menge beim Kappen unverändert (bisheriges Verhalten, s. Doku)', () => {
		// Charakterisierung, kein Soll: stünde hier ein Neuaufbau, wäre 'k10' weg.
		const k = new Set(['k10']);
		const r = einfuegen([msg('10', { krypto_id: 'k10' }), msg('20')], new Set(['10', '20']), k, msg('30'), 2);
		assert.ok(r);
		assert.deepEqual([...k], ['k10']);
	});
});
