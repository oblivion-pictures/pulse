import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { liveBehalten } from '../src/lib/nachrichten/liveBehalten.ts';
import type { Message } from '../src/lib/api/types.ts';

/**
 * „Wenn ich einen Chat offen habe, kommen manchmal Nachrichten nicht an"
 * (Push-Bughunt, 2026-10-21). Zwei Ursachen:
 *
 * 1. Das Laden beim Öffnen (`setInitial` nach `await`) ersetzte die ganze
 *    Liste — eine verschlüsselte Nachricht, die während des Serverabrufs per
 *    `upsert` angezeigt wurde, stand weder im lokalen Schnappschuss noch in
 *    der Serverantwort und verschwand. Die Rechnung: `nachrichten/liveBehalten.ts`.
 * 2. Der `switchTo`-Effekt der DM-Seite hing an `directMessages.byId`; jede
 *    DM-Aktivität startete ihn neu, erhöhte den Generationszähler und ließ die
 *    noch laufenden Nachzüge (Sicherung, Archiv) als veraltet verfallen.
 *
 * Die Verdrahtung prüft der Test an der Quelle — die Module ziehen `$lib`-
 * Aliase und Runen nach sich, die Nodes Testläufer nicht auflöst.
 */
const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');

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

describe('liveBehalten: ein Laden verdrängt nichts, was seither eintraf', () => {
	it('behält eine live angezeigte Nachricht, die die geladene Liste nicht kennt', () => {
		const geladen = [msg('100000000000000010'), msg('100000000000000020')];
		const live = msg('100000000000000030', { krypto_id: '100000000000000030' });
		assert.deepEqual(ids(liveBehalten([live], geladen)), [
			'100000000000000010',
			'100000000000000020',
			'100000000000000030'
		]);
	});

	it('nimmt bei gleicher Id die geladene Fassung', () => {
		const geladen = [msg('100000000000000010', { content: 'geladen' })];
		const r = liveBehalten([msg('100000000000000010', { content: 'live' })], geladen);
		assert.equal(r.length, 1);
		assert.equal(r[0].content, 'geladen');
	});

	it('erkennt dieselbe Nachricht unter anderer lokaler Id über die Identität', () => {
		// Live: Zustellungs-Id D mit Kennung K; geladen: die Kopie unter K selbst.
		const live = msg('100000000000000099', { krypto_id: '100000000000000050' });
		const geladen = [msg('100000000000000050')];
		assert.deepEqual(ids(liveBehalten([live], geladen)), ['100000000000000050']);
	});

	it('behält dieselbe Kennung eines ANDEREN Autors', () => {
		const live = msg('100000000000000099', { author_id: 'b', krypto_id: '100000000000000050' });
		const geladen = [msg('100000000000000050')];
		assert.equal(liveBehalten([live], geladen).length, 2);
	});

	it('lässt vorläufige tmp-Kopien fallen (wie bisher)', () => {
		const tmp = msg('tmp-n-1', { nonce: 'n-1' });
		const geladen = [msg('100000000000000010')];
		assert.equal(liveBehalten([tmp], geladen), geladen);
	});

	it('gibt die geladene Liste unverändert zurück, wenn nichts zu behalten ist', () => {
		const geladen = [msg('100000000000000010')];
		assert.equal(liveBehalten([], geladen), geladen);
		assert.equal(liveBehalten([msg('100000000000000010')], geladen), geladen);
	});
});

describe('Verdrahtung: Laden nach await behält live Eingetroffenes', () => {
	it('der Store reicht die Option an liveBehalten durch', () => {
		const store = lies('lib/stores/messages.svelte.ts');
		assert.match(store, /setInitial\(channelId: string, msgs: Message\[\], opts\?: \{ liveBehalten\?: boolean \}\)/);
		assert.match(store, /opts\?\.liveBehalten \? liveBehalten\(this\.byChannel\[channelId\] \?\? \[\], msgs\) : msgs/);
	});

	it('DM-Wechsel: jedes setInitial nach einem await behält, nur das Leeren nicht', () => {
		const q = lies('lib/components/chat/dmKanalWechsel.svelte.ts');
		const aufrufe = [...q.matchAll(/messages\.setInitial\(([^;]*)\);/g)].map((t) => t[1]);
		const leeren = aufrufe.filter((a) => /, \[\]$/.test(a));
		const laden = aufrufe.filter((a) => !/, \[\]$/.test(a));
		assert.equal(leeren.length, 2);
		assert.equal(laden.length, 4);
		for (const a of laden) assert.match(a, /\{ liveBehalten: true \}$/);
	});

	it('Community-Kanal: Laden aus dem Server behält ebenfalls', () => {
		const q = lies('lib/components/chat/kanalWechsel.svelte.ts');
		assert.match(q, /messages\.setInitial\(target, history, \{ liveBehalten: true \}\)/);
		assert.match(q, /messages\.setInitial\(cid, history, \{ liveBehalten: true \}\)/);
	});
});

describe('Verdrahtung: der switchTo-Effekt hängt nur an der Gesprächs-Id', () => {
	it('liest dmChannelId getrackt und ruft switchTo ungetrackt', () => {
		const seite = lies('routes/app/@me/[[dmChannelId]]/+page.svelte');
		assert.match(
			seite,
			/\$effect\(\(\) => \{\s*const cid = dmChannelId;\s*untrack\(\(\) => void kanalWechsel\.switchTo\(cid\)\);\s*\}\);/
		);
		assert.doesNotMatch(seite, /\$effect\(\(\) => \{\s*void kanalWechsel\.switchTo\(dmChannelId\);/);
	});
});
