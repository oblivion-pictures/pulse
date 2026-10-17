import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	SENDUNGEN_BIS_ZUR_FRAGE,
	sollFragen
} from '../src/lib/platform/bewertungRegel.ts';

test('am Anfang wird nicht gefragt', () => {
	// Genau der Moment, in dem ein Nutzer die App noch nicht kennt.
	assert.equal(sollFragen({ gesendet: 0, bereitsGefragt: false }), false);
	assert.equal(sollFragen({ gesendet: 1, bereitsGefragt: false }), false);
});

test('eine Sendung vor der Schwelle reicht noch nicht', () => {
	assert.equal(
		sollFragen({ gesendet: SENDUNGEN_BIS_ZUR_FRAGE - 1, bereitsGefragt: false }),
		false
	);
});

test('ab der Schwelle wird gefragt', () => {
	assert.equal(
		sollFragen({ gesendet: SENDUNGEN_BIS_ZUR_FRAGE, bereitsGefragt: false }),
		true
	);
});

test('zweimal fragen gibt es nicht', () => {
	// iOS zeigt die Frage hoechstens dreimal im Jahr und sagt nicht, ob sie
	// erschienen ist — ein zweiter Versuch verbrennt nur Kontingent.
	assert.equal(
		sollFragen({ gesendet: 9999, bereitsGefragt: true }),
		false
	);
});

test('ohne Plugin im Bau wird nicht gefragt — und es gilt nicht als gefragt (F8)', () => {
	// iOS-Bughunt 2, F8: ein älterer Bau ohne ReviewPlugin verbrauchte die
	// einzige Frage, bevor er sie stellen konnte.
	assert.equal(
		sollFragen({ gesendet: SENDUNGEN_BIS_ZUR_FRAGE, bereitsGefragt: false, pluginDa: false }),
		false
	);
	assert.equal(
		sollFragen({ gesendet: SENDUNGEN_BIS_ZUR_FRAGE, bereitsGefragt: false, pluginDa: true }),
		true
	);
});

import {
	FRAGE_MINDESTWARTEN_MS,
	FRAGE_WARTEN_MAX_MS,
	alsGefragtWerten,
	frageMoment
} from '../src/lib/platform/bewertungRegel.ts';

test('B13: nicht direkt nach dem Senden und nicht bei offener Tastatur', () => {
	assert.equal(frageMoment({ tastaturOffen: false, seitSendenMs: 100 }), 'warten');
	assert.equal(
		frageMoment({ tastaturOffen: true, seitSendenMs: FRAGE_MINDESTWARTEN_MS + 5000 }),
		'warten'
	);
	assert.equal(
		frageMoment({ tastaturOffen: false, seitSendenMs: FRAGE_MINDESTWARTEN_MS }),
		'fragen'
	);
});

test('B13: wer ewig tippt, bekommt die Frage nicht aufgedrängt (Versuch verfällt)', () => {
	assert.equal(
		frageMoment({ tastaturOffen: true, seitSendenMs: FRAGE_WARTEN_MAX_MS + 1 }),
		'verwerfen'
	);
});

test('B13: gefragt zählt erst, wenn die Hülle es bestätigt — ältere Bauten wie bisher', () => {
	assert.equal(alsGefragtWerten({ angezeigt: true }), true);
	assert.equal(alsGefragtWerten({ angezeigt: false }), false);
	// Älterer Bau: Antwort ohne Feld (oder gar keine) = wie bisher gefragt.
	assert.equal(alsGefragtWerten(undefined), true);
	assert.equal(alsGefragtWerten(null), true);
	assert.equal(alsGefragtWerten({}), true);
});
