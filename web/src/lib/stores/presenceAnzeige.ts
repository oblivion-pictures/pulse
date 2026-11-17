/**
 * Anzeige-Status eines Peers — die reine Rechnung hinter
 * `PresenceStore.displayStatus`/`displayStatusForFriend`/`isOnline`,
 * importfrei (s. `pnpm test:unit`-Falle in CLAUDE.md).
 *
 * Zwei Eingaben, eine Rangfrage:
 *
 *  * ``online`` — die Live-Socket-Menge (``ready.online_user_ids`` und
 *    ``presence_update``). Sagt nur, ob ein Socket offen ist — NICHT, ob
 *    der Peer gesehen werden will.
 *  * ``explizit`` — die (serverseitig maskierte) Status-Map aus
 *    ``user_presence_statuses`` / ``presence_status_changed``. Für einen
 *    unsichtbaren Peer steht hier ``offline``, obwohl sein Socket offen
 *    ist — genau das ist der Draht-Zustand von „unsichtbar“.
 *
 * Bis 2026-11-17 las der Store das als Widerspruch und liess die Socket-
 * Menge gewinnen: ein unsichtbarer Freund mit offenem Socket wurde als
 * online angezeigt — im Ready-Seed (``online_user_ids`` enthielt unsichtbare
 * Socket-IDs) und nach jedem Reconnect des Freundes (``presence_update``
 * online=true). Auflösung: die Maskierung gewinnt. Explizites ``offline``
 * zeigt offline, egal was die Socket-Menge sagt; ``idle``/``dnd`` gelten
 * nur obendrauf, wenn auch ein Socket offen ist (ein abgestelltes ``dnd``
 * von vor dem Disconnect macht niemanden online).
 */
export type AnzeigeStatus = 'online' | 'idle' | 'dnd' | 'offline';

export function peerAnzeigeStatus(
	online: boolean,
	explizit: AnzeigeStatus | undefined
): AnzeigeStatus {
	// Invisible-Maske geht vor: „offline“ ist der Peer-Wunsch, kein
	// Widerspruch zum offenen Socket.
	if (explizit === 'offline') return 'offline';
	// Kein Socket → offline, auch wenn noch ``dnd`` klebt.
	if (!online) return 'offline';
	return explizit ?? 'online';
}

export function peerIstOnline(
	online: boolean,
	explizit: AnzeigeStatus | undefined
): boolean {
	return peerAnzeigeStatus(online, explizit) !== 'offline';
}
