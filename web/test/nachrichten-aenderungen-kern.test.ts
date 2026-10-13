import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	abgleichen,
	pinSpiegel,
	pinsFortschreiben,
	reaktionAnwenden,
	reaktionenGleich
} from '../src/lib/nachrichten/aenderungenKern.ts';
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
const jetzt = () => '2026-10-13T12:00:00.000Z';

describe('Reaktionen anwenden', () => {
	it('fügt ein neues Emoji hinzu und setzt „me“ nur für den Reagierenden', () => {
		assert.deepEqual(reaktionAnwenden(undefined, '👍', 1, true), [{ emoji: '👍', count: 1, me: true }]);
		assert.deepEqual(reaktionAnwenden([], '👍', 1, false), [{ emoji: '👍', count: 1, me: false }]);
	});

	it('zählt ein bestehendes Emoji hoch und lässt „me“ eines Fremden unberührt', () => {
		const bisher = [{ emoji: '👍', count: 1, me: true }];
		assert.deepEqual(reaktionAnwenden(bisher, '👍', 1, false), [{ emoji: '👍', count: 2, me: true }]);
		assert.deepEqual(bisher, [{ emoji: '👍', count: 1, me: true }], 'Eingabe bleibt unverändert');
	});

	it('Entfernen: zählt herunter, nimmt „me“ weg und löscht den Eintrag bei 0', () => {
		const zwei = [{ emoji: '👍', count: 2, me: true }];
		assert.deepEqual(reaktionAnwenden(zwei, '👍', -1, true), [{ emoji: '👍', count: 1, me: false }]);
		assert.deepEqual(reaktionAnwenden([{ emoji: '👍', count: 1, me: true }], '👍', -1, true), []);
	});

	it('Entfernen eines unbekannten Emojis ist „nichts zu tun“ (null)', () => {
		assert.equal(reaktionAnwenden([{ emoji: '👍', count: 1, me: false }], '🎉', -1, false), null);
		assert.equal(reaktionAnwenden(undefined, '🎉', -1, false), null);
	});

	it('reaktionenGleich vergleicht Länge, Emoji, Zahl und „me“', () => {
		const a = [{ emoji: '👍', count: 1, me: false }];
		assert.ok(reaktionenGleich(a, [{ emoji: '👍', count: 1, me: false }]));
		assert.ok(!reaktionenGleich(a, []));
		assert.ok(!reaktionenGleich(a, [{ emoji: '👍', count: 2, me: false }]));
		assert.ok(!reaktionenGleich(a, [{ emoji: '👍', count: 1, me: true }]));
		assert.ok(!reaktionenGleich(a, [{ emoji: '🎉', count: 1, me: false }]));
	});
});

describe('Pins fortschreiben', () => {
	const evt = (pinned: boolean) => ({ channel_id: 'k1', message_id: '7', pinned });

	it('Pinnen mit geladener Nachricht hängt eine vollständige Kopie an', () => {
		const geladen = msg('7', { content: 'hallo' });
		const r = pinsFortschreiben([msg('1')], evt(true), geladen, jetzt);
		assert.equal(r.length, 2);
		assert.equal(r[1].content, 'hallo');
		assert.equal(r[1].pinned_at, jetzt());
	});

	it('Pinnen ohne geladene Nachricht hängt den schmalen Platzhalter an', () => {
		const r = pinsFortschreiben([], evt(true), undefined, jetzt);
		assert.deepEqual(r, [{ id: '7', channel_id: 'k1', pinned_at: jetzt() }]);
	});

	it('ein schon gepinnter Eintrag lässt die Liste unverändert (dieselbe Referenz)', () => {
		const l = [msg('7')];
		assert.equal(pinsFortschreiben(l, evt(true), undefined, jetzt), l);
	});

	it('Entpinnen nimmt den Eintrag heraus; Entpinnen von etwas Fehlendem ändert nichts', () => {
		const l = [msg('1'), msg('7')];
		assert.deepEqual(pinsFortschreiben(l, evt(false), undefined, jetzt).map((m) => m.id), ['1']);
		const ohne7 = [msg('1')];
		assert.equal(pinsFortschreiben(ohne7, evt(false), undefined, jetzt), ohne7);
	});

	it('der pinned_at-Spiegel behält einen vorhandenen Zeitpunkt und setzt beim Entpinnen null', () => {
		assert.equal(pinSpiegel(msg('1'), true, jetzt).pinned_at, jetzt());
		assert.equal(pinSpiegel(msg('1', { pinned_at: 'frueher' }), true, jetzt).pinned_at, 'frueher');
		assert.equal(pinSpiegel(msg('1', { pinned_at: 'frueher' }), false, jetzt).pinned_at, null);
	});
});

describe('Abgleich mit einem frisch geholten Serverstand', () => {
	it('gibt DIESELBE Liste zurück, wenn nichts abweicht', () => {
		const l = [msg('1', { reactions: [{ emoji: '👍', count: 1, me: false }] }), msg('2')];
		const frisch = [msg('1', { reactions: [{ emoji: '👍', count: 1, me: false }] }), msg('2')];
		assert.equal(abgleichen(l, frisch), l);
	});

	it('übernimmt Inhalt, Bearbeitungszeit und Reaktionen und lässt Unveränderte als Referenz stehen', () => {
		const l = [msg('1'), msg('2')];
		const r = abgleichen(l, [
			msg('2', { content: 'bearbeitet', edited_at: 'E', reactions: [{ emoji: '🎉', count: 2, me: true }] })
		]);
		assert.notEqual(r, l);
		assert.equal(r[0], l[0]);
		assert.equal(r[1].content, 'bearbeitet');
		assert.equal(r[1].edited_at, 'E');
		assert.deepEqual(r[1].reactions, [{ emoji: '🎉', count: 2, me: true }]);
	});

	it('fehlende Reaktionen im Serverstand lassen die vorhandenen stehen', () => {
		const vorhanden = [{ emoji: '👍', count: 1, me: true }];
		const l = [msg('1', { reactions: vorhanden, content: 'alt' })];
		const r = abgleichen(l, [msg('1', { content: 'neu' })]);
		assert.deepEqual(r[0].reactions, vorhanden);
		assert.equal(r[0].content, 'neu');
	});

	it('ignoriert neue Nachrichten im Serverstand', () => {
		const l = [msg('1')];
		assert.equal(abgleichen(l, [msg('1'), msg('2')]), l);
	});
});
