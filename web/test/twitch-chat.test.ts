import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// Twitch-Live-Chat der Watch-Partys: IRC-Parser (twitchIrc.ts) und der
// Verbindungsautomat (twitchChatConnector.ts) sind bewusst importfrei bzw.
// mit injizierbarer Socket-Fabrik gebaut — nur so laufen sie unter Nodes
// Testläufer (CLAUDE.md: die pnpm test:unit-Falle).

import {
	anzeigeFarbe,
	ersatzFarbe,
	lesbareFarbe,
	parseChatMessage
} from '../src/lib/watch/twitchIrc.ts';
import {
	TwitchChatConnector,
	type TwitchSocketLike
} from '../src/lib/watch/twitchChatConnector.ts';

const CTCP = String.fromCharCode(1);

/** WebSocket-Fake: zeichnet Gesendetes auf, Server-Seite per server()/drop(). */
class FakeSocket {
	static created: FakeSocket[] = [];
	sent: string[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor() {
		FakeSocket.created.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
	}

	/** Eine Server-Zeile zustellen (inkl. \r\n-Rahmen wie im echten IRC). */
	server(line: string): void {
		this.onmessage?.({ data: `${line}\r\n` });
	}

	/** Server trennt die Verbindung. */
	drop(): void {
		this.onclose?.();
	}
}

function privmsg(id: string, name: string, text: string): string {
	return `@color=#FF0000;display-name=${name};emotes=;id=${id} :${name.toLowerCase()}!x@x.tmi.twitch.tv PRIVMSG #testchan :${text}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Frischen Connector mit Fake-Socket bauen und den Handshake durchziehen. */
function verbundeneVerbindung(): { conn: TwitchChatConnector; sock: FakeSocket } {
	const conn = new TwitchChatConnector('TestChan', {
		socketFactory: () => new FakeSocket(),
		flushMs: 15,
		retryDelaysMs: [10, 20]
	});
	conn.start();
	const sock = FakeSocket.created[FakeSocket.created.length - 1];
	sock.onopen?.();
	sock.server(':tmi.twitch.tv 001 justinfan1 :Welcome');
	sock.server(':u!u@u.tmi.twitch.tv JOIN #testchan');
	return { conn, sock };
}

describe('twitchIrc — Parser', () => {
	it('PRIVMSG mit Tags: Name (mit entschärftem Leerzeichen), Farbe, Emote', () => {
		const msg = parseChatMessage(
			'@color=#1E90FF;display-name=Half\\ssugar;emotes=25:0-4;id=abc123 :halfsugar!halfsugar@h.tmi.twitch.tv PRIVMSG #chan :Kappa Hallo'
		);
		assert.ok(msg);
		assert.equal(msg.id, 'abc123');
		assert.equal(msg.login, 'halfsugar');
		assert.equal(msg.displayName, 'Half sugar');
		assert.equal(msg.color, '#1E90FF');
		assert.equal(msg.action, false);
		assert.deepEqual(msg.parts, [
			{ kind: 'emote', id: '25', name: 'Kappa' },
			{ kind: 'text', text: ' Hallo' }
		]);
	});

	it('Emote-Positionen zählen Codepoints, nicht UTF-16 (Emoji davor)', () => {
		// '🎉 PogChamp !' — PogChamp liegt bei Codepoints 2-9.
		const msg = parseChatMessage(
			'@emotes=305954156:2-9 :u!u@u.tmi.twitch.tv PRIVMSG #chan :🎉 PogChamp !'
		);
		assert.ok(msg);
		assert.deepEqual(msg.parts, [
			{ kind: 'text', text: '🎉 ' },
			{ kind: 'emote', id: '305954156', name: 'PogChamp' },
			{ kind: 'text', text: ' !' }
		]);
	});

	it('ohne display-name/color fällt der Parser auf den Login zurück', () => {
		const msg = parseChatMessage(':foo!foo@f.tmi.twitch.tv PRIVMSG #chan :hi');
		assert.ok(msg);
		assert.equal(msg.displayName, 'foo');
		assert.equal(msg.color, null);
		assert.deepEqual(msg.parts, [{ kind: 'text', text: 'hi' }]);
	});

	it('/me-Aktionen verlieren den CTCP-Rahmen und gelten als Aktion', () => {
		const msg = parseChatMessage(
			`:a!a@a.tmi.twitch.tv PRIVMSG #chan :${CTCP}ACTION winkt${CTCP}`
		);
		assert.ok(msg);
		assert.equal(msg.action, true);
		assert.deepEqual(msg.parts, [{ kind: 'text', text: 'winkt' }]);
	});

	it('alles, was kein PRIVMSG ist, ergibt null', () => {
		assert.equal(parseChatMessage('PING :tmi.twitch.tv'), null);
		assert.equal(parseChatMessage(':u!u@u.tmi.twitch.tv JOIN #chan'), null);
		assert.equal(parseChatMessage(':tmi.twitch.tv 001 justinfan1 :Welcome'), null);
		assert.equal(parseChatMessage(''), null);
	});

	it('Farb-Helfer: dunkle Farben anheben, Ersatzfarbe deterministisch', () => {
		assert.equal(lesbareFarbe('#FFFFFF'), '#FFFFFF');
		const schwarz = lesbareFarbe('#000000');
		assert.ok(/^#[0-9a-f]{6}$/i.test(schwarz));
		assert.notEqual(schwarz, '#000000');
		assert.equal(ersatzFarbe('foo'), ersatzFarbe('foo'));
		assert.equal(anzeigeFarbe(null, 'foo'), ersatzFarbe('foo'));
		assert.equal(anzeigeFarbe('#000000', 'foo'), lesbareFarbe('#000000'));
	});
});

describe('TwitchChatConnector — Verbindungsautomat', () => {
	it('Handshake: anonym + Tags, JOIN nach 001 (kleingeschrieben), connected', () => {
		FakeSocket.created = [];
		const status: string[] = [];
		const { conn, sock } = verbundeneVerbindung();
		conn.onStatus = (s) => status.push(s);
		// Status-Übergang provozieren (Verlust → reconnecting):
		sock.drop();
		assert.ok(status.includes('reconnecting'));
		assert.ok(sock.sent.includes('PASS SCHMOOPIIE'));
		assert.ok(sock.sent.some((l) => /^NICK justinfan\d+$/.test(l)));
		assert.ok(sock.sent.includes('CAP REQ :twitch.tv/tags'));
		assert.ok(sock.sent.includes('JOIN #testchan'));
		conn.stop();
	});

	it('PRIVMSG-Stöße kommen gebündelt, der Ring kappt bei 150', async () => {
		FakeSocket.created = [];
		const { conn, sock } = verbundeneVerbindung();
		const batches: number[] = [];
		conn.onMessages = (batch) => batches.push(batch.length);
		sock.server(privmsg('1', 'A', 'eins'));
		sock.server(privmsg('2', 'B', 'zwei'));
		sock.server(privmsg('3', 'C', 'drei'));
		assert.deepEqual(batches, []); // noch im Sammelbehälter
		await sleep(40);
		assert.deepEqual(batches, [3]);
		assert.equal(conn.messages.length, 3);
		// Großkanal-Stoß: 200 auf einmal → Ring behält die neuesten 150.
		for (let i = 0; i < 200; i++) sock.server(privmsg(`m${i}`, 'X', `x${i}`));
		await sleep(40);
		assert.equal(conn.messages.length, 150);
		const erste = conn.messages[0];
		assert.ok(erste);
		assert.equal(erste.id, 'm50'); // die ältesten 50 sind gefallen
		conn.stop();
	});

	it('PING wird mit PONG beantwortet', () => {
		FakeSocket.created = [];
		const { conn, sock } = verbundeneVerbindung();
		sock.server('PING :tmi.twitch.tv');
		assert.ok(sock.sent.includes('PONG :tmi.twitch.tv'));
		conn.stop();
	});

	it('Verbindungsabbruch führt zu neuem Socket und erneutem JOIN', async () => {
		FakeSocket.created = [];
		const { sock } = verbundeneVerbindung();
		const alt = sock;
		alt.drop();
		await sleep(30); // retryDelaysMs: [10, 20]
		assert.equal(FakeSocket.created.length, 2);
		const neu = FakeSocket.created[1];
		assert.ok(neu);
		neu.onopen?.();
		neu.server(':tmi.twitch.tv 001 justinfan2 :Welcome');
		assert.ok(neu.sent.includes('JOIN #testchan'));
	});

	it('stop() trennt und stellt die Wiederverbindung ab', async () => {
		FakeSocket.created = [];
		const { conn, sock } = verbundeneVerbindung();
		conn.stop();
		assert.equal(sock.closed, true);
		sock.drop(); // spätes onclose darf nichts mehr anstoßen
		await sleep(30);
		assert.equal(FakeSocket.created.length, 1);
	});

	it('doppelt start() öffnet keine zweite Verbindung', () => {
		FakeSocket.created = [];
		const conn = new TwitchChatConnector('chan', {
			socketFactory: () => new FakeSocket(),
			flushMs: 15,
			retryDelaysMs: [10]
		});
		conn.start();
		conn.start();
		assert.equal(FakeSocket.created.length, 1);
		conn.stop();
	});
});
