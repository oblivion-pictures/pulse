import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	changedLimitsPayload,
	toDisplay,
	type LimitFieldSpec
} from '../src/lib/components/settings/guildLimitUnits.ts';

const MB = 1024 * 1024;

const FELDER: LimitFieldSpec[] = [
	{ key: 'voice_bitrate_kbps', kind: 'raw' },
	{ key: 'stream_bitrate_kbps', kind: 'mbps' },
	{ key: 'stream_resolution', kind: 'resolution' },
	{ key: 'attachment_max_size_bytes', kind: 'mb', required: true },
	{ key: 'attachment_max_count_per_message', kind: 'raw', required: true },
	{ key: 'attachment_storage_quota_bytes', kind: 'gb' },
	{ key: 'max_members', kind: 'raw' }
];

/** Gespeicherter Stand mit einem Wert, der in der Anzeige gerundet wird. */
const GESPEICHERT = {
	voice_bitrate_kbps: 128,
	stream_bitrate_kbps: 2500,
	stream_resolution: '1080p',
	attachment_max_size_bytes: 1_000_000,
	attachment_max_count_per_message: 4,
	attachment_storage_quota_bytes: null,
	max_members: null
};

/** Das Formular direkt nach dem Laden: jedes Feld zeigt die Anzeige seines Wertes. */
const frisch = (): Record<string, string> =>
	Object.fromEntries(
		FELDER.map((f) => [f.key, toDisplay(GESPEICHERT[f.key as keyof typeof GESPEICHERT], f.kind)])
	);

describe('Community-Grenzen: was beim Speichern mitgeht', () => {
	it('ein unberührtes Formular schickt nichts', () => {
		assert.deepEqual(changedLimitsPayload(FELDER, frisch(), GESPEICHERT), {});
	});

	it('die gerundete Anzeige überschreibt keinen gespeicherten Wert', () => {
		// 1.000.000 Byte werden als 0.95 MB gezeigt; 0.95 MB wären 996.147 Byte.
		const eingaben = frisch();
		assert.equal(eingaben.attachment_max_size_bytes, '0.95');
		eingaben.max_members = '50'; // nur ein ganz anderes Feld ändern
		const nutzlast = changedLimitsPayload(FELDER, eingaben, GESPEICHERT);
		assert.deepEqual(nutzlast, { max_members: 50 });
		assert.ok(!('attachment_max_size_bytes' in nutzlast));
	});

	it('ein geändertes Feld geht in Wire-Einheiten mit', () => {
		const eingaben = frisch();
		eingaben.attachment_max_size_bytes = '40';
		eingaben.stream_bitrate_kbps = '3';
		eingaben.stream_resolution = '720p';
		assert.deepEqual(changedLimitsPayload(FELDER, eingaben, GESPEICHERT), {
			attachment_max_size_bytes: 40 * MB,
			stream_bitrate_kbps: 3000,
			stream_resolution: '720p'
		});
	});

	it('ein geleertes optionales Feld schickt null (Vorgabe des Betreibers)', () => {
		const eingaben = frisch();
		eingaben.voice_bitrate_kbps = '';
		eingaben.stream_resolution = '';
		assert.deepEqual(changedLimitsPayload(FELDER, eingaben, GESPEICHERT), {
			voice_bitrate_kbps: null,
			stream_resolution: null
		});
	});

	it('ein geleertes Pflichtfeld wird ausgelassen: leer heißt nicht ändern', () => {
		// Ein null dort wäre am Server ein 422 (NOT-NULL-Spalte).
		const eingaben = frisch();
		eingaben.attachment_max_size_bytes = '';
		eingaben.attachment_max_count_per_message = '';
		eingaben.max_members = '10';
		assert.deepEqual(changedLimitsPayload(FELDER, eingaben, GESPEICHERT), { max_members: 10 });
	});

	it('ein nie gesetztes optionales Feld, das leer bleibt, schickt nichts', () => {
		const eingaben = frisch();
		assert.equal(eingaben.max_members, '');
		assert.ok(!('max_members' in changedLimitsPayload(FELDER, eingaben, GESPEICHERT)));
	});

	it('ein Pflichtfeld wird geändert, nicht ausgelassen', () => {
		const eingaben = frisch();
		eingaben.attachment_max_count_per_message = '8';
		assert.deepEqual(changedLimitsPayload(FELDER, eingaben, GESPEICHERT), {
			attachment_max_count_per_message: 8
		});
	});

	it('Zurücktippen auf den Stand des Servers nach einem Speichern schickt nichts', () => {
		// Server hat inzwischen 40 MB; das Formular steht (neu aufgesetzt) auf 40.
		const stand = { ...GESPEICHERT, attachment_max_size_bytes: 40 * MB };
		const eingaben = { ...frisch(), attachment_max_size_bytes: '40' };
		assert.deepEqual(changedLimitsPayload(FELDER, eingaben, stand), {});
	});
});
