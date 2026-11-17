import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	peerAnzeigeStatus,
	peerIstOnline
} from '../src/lib/stores/presenceAnzeige.ts';

/**
 * Die Rangfolge hinter ``PresenceStore.displayStatus`` /
 * ``displayStatusForFriend`` / ``isOnline`` (2026-11-17: „unsichtbare
 * Freunde erscheinen online“). Bughunt-Fälle:
 *
 *  1. Ready-Seed: ``online_user_ids`` enthielt den unsichtbaren Peer
 *     (Socket offen), die maskierte Map sagte ``offline`` — der Store las
 *     das als Widerspruch und zeigte online.
 *  2. Reconnect: ``presence_update`` online=true stellte den Peer in die
 *     Socket-Menge zurück, ohne dass eine Statusmeldung folgte.
 */
test('maskiertes offline gewinnt über den offenen Socket (unsichtbarer Peer)', () => {
	assert.equal(peerAnzeigeStatus(true, 'offline'), 'offline');
	assert.equal(peerIstOnline(true, 'offline'), false);
	assert.equal(peerAnzeigeStatus(false, 'offline'), 'offline');
	assert.equal(peerIstOnline(false, 'offline'), false);
});

test('ohne expliziten Eintrag entscheidet die Socket-Menge', () => {
	assert.equal(peerAnzeigeStatus(true, undefined), 'online');
	assert.equal(peerIstOnline(true, undefined), true);
	assert.equal(peerAnzeigeStatus(false, undefined), 'offline');
	assert.equal(peerIstOnline(false, undefined), false);
});

test('idle/dnd gelten nur obendrauf, wenn ein Socket offen ist', () => {
	assert.equal(peerAnzeigeStatus(true, 'idle'), 'idle');
	assert.equal(peerAnzeigeStatus(true, 'dnd'), 'dnd');
	// Abgestelltes dnd/idle von vor dem Disconnect macht niemanden online.
	assert.equal(peerAnzeigeStatus(false, 'dnd'), 'offline');
	assert.equal(peerAnzeigeStatus(false, 'idle'), 'offline');
});
