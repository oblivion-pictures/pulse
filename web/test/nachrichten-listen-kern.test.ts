import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	echoErsetzen,
	einfuegen as einfuegenKern,
	einsortieren,
	entfernen,
	ersetzeNachricht,
	identitaetenVon,
	kappen,
	letzteServerId,
	lueckeZusammenfuehren,
	mengenNachLuecke,
	ohneGrabsteine,
	vorneAnfuegen as vorneAnfuegenKern
} from '../src/lib/nachrichten/listenKern.ts';
import type { Message } from '../src/lib/api/types.ts';

// Die meisten Fälle kennen keine Grabsteine: ohne Angabe gibt es keine.
const einfuegen = (
	liste: Message[],
	ids: Set<string>,
	krypto: Set<string>,
	nachricht: Message,
	cap: number,
	begraben: ReadonlySet<string> = new Set()
) => einfuegenKern(liste, ids, krypto, nachricht, cap, begraben);
const vorneAnfuegen = (
	liste: Message[],
	ids: Set<string>,
	krypto: Set<string>,
	nachrichten: Message[],
	cap: number,
	begraben: ReadonlySet<string> = new Set()
) => vorneAnfuegenKern(liste, ids, krypto, nachrichten, cap, begraben);

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
/** Die Identität, wie der Store sie führt: Autor + Kennung (Vorgabe-Autor `a`). */
const ident = (kennung: string, autor = 'a') => `${autor}:${kennung}`;

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

	it('identitaetenVon: Autor + krypto_id, ohne sie die eigene Id', () => {
		const s = identitaetenVon([
			msg('1', { krypto_id: 'k' }),
			msg('2'),
			msg('3', { krypto_id: 'k' }),
			msg('4', { krypto_id: 'k', author_id: 'b' })
		]);
		assert.deepEqual([...s].sort(), [ident('2'), ident('k'), ident('k', 'b')]);
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
		assert.deepEqual([...k].sort(), [ident('10'), ident('x')]);
	});

	it('die Identität blockt die Archiv-Kopie mit fremder lokaler Id', () => {
		// Live empfangen: id=Zustellungs-Id, krypto_id=Kennung. Die Archiv-Kopie
		// trägt die Kennung als `id`.
		const l = [msg('30', { krypto_id: '15' })];
		const r = vorneAnfuegen(l, new Set(['30']), identitaetenVon(l), [msg('15')], 100);
		assert.equal(r, null);
	});

	it('zwei Kopien derselben Nachricht in EINER Seite: nur die erste kommt durch', () => {
		const l = [msg('30')];
		const r = vorneAnfuegen(
			l,
			new Set(['30']),
			identitaetenVon(l),
			[msg('15'), msg('12', { krypto_id: '15' })],
			100
		);
		assert.ok(r);
		assert.deepEqual(ids(r.neu), ['12']);
	});

	it('liefert null, wenn nichts Neues dabei war, und lässt die Mengen unberührt', () => {
		const i = new Set(['30']);
		assert.equal(vorneAnfuegen([msg('30')], i, new Set(), [msg('30')], 100), null);
		assert.deepEqual([...i], ['30']);
	});

	it('baut beide Mengen aus der gekappten Liste neu auf', () => {
		const l = [msg('30', { krypto_id: 'k30' })];
		const i = new Set(['30']);
		const k = identitaetenVon(l);
		const r = vorneAnfuegen(l, i, k, [msg('10', { krypto_id: 'k10' }), msg('20', { krypto_id: 'k20' })], 2);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['20', '30']);
		assert.deepEqual(ids(r.verworfen), ['10']);
		assert.deepEqual([...i].sort(), ['20', '30']);
		assert.deepEqual([...k].sort(), [ident('k20'), ident('k30')]);
	});
});

describe('Nachrichtenliste: einzelne Nachricht aufnehmen', () => {
	it('nimmt eine neue Nachricht auf und bucht Id und Identität', () => {
		const i = new Set<string>();
		const k = new Set<string>();
		const r = einfuegen([], i, k, msg('10', { krypto_id: 'x' }), 100);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['10']);
		assert.deepEqual([...i], ['10']);
		assert.deepEqual([...k], [ident('x')]);
	});

	it('weist ein Duplikat über die Id UND über die Identität ab', () => {
		const l = [msg('10', { krypto_id: 'x' })];
		const k = identitaetenVon(l);
		assert.equal(einfuegen(l, new Set(['10']), k, msg('10'), 100), null);
		assert.equal(einfuegen(l, new Set(['10']), k, msg('99', { krypto_id: 'x' }), 100), null);
		// Die Gegenrichtung: die Kennung der bekannten Kopie ist die neue `id`.
		assert.equal(einfuegen(l, new Set(['10']), k, msg('x'), 100), null);
	});

	it('Autor-Bindung: dieselbe Kennung eines anderen Autors ist eine andere Nachricht', () => {
		const l = [msg('10', { krypto_id: 'x' })];
		const r = einfuegen(l, new Set(['10']), identitaetenVon(l), msg('99', { krypto_id: 'x', author_id: 'b' }), 100);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['10', '99']);
	});

	it('kappt und baut die Id-Menge neu auf', () => {
		const i = new Set(['10', '20']);
		const r = einfuegen([msg('10'), msg('20')], i, new Set(), msg('30'), 2);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['20', '30']);
		assert.deepEqual(ids(r.verworfen), ['10']);
		assert.deepEqual([...i].sort(), ['20', '30']);
	});

	it('baut beim Kappen auch die krypto-Menge aus der Liste neu auf', () => {
		const i = new Set(['10', '20']);
		const k = new Set([ident('k10'), ident('k20')]);
		const r = einfuegen(
			[msg('10', { krypto_id: 'k10' }), msg('20', { krypto_id: 'k20' })],
			i,
			k,
			msg('30', { krypto_id: 'k30' }),
			2
		);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['20', '30']);
		assert.deepEqual([...i].sort(), ['20', '30']);
		assert.deepEqual([...k].sort(), [ident('k20'), ident('k30')]);
	});

	it('nach dem Kappen erkennt die Dublettenprüfung nur noch, was wirklich in der Liste steht', () => {
		const i = new Set(['10', '20']);
		const k = new Set([ident('k10'), ident('k20')]);
		const erste = einfuegen(
			[msg('10', { krypto_id: 'k10' }), msg('20', { krypto_id: 'k20' })],
			i,
			k,
			msg('30'),
			2
		);
		assert.ok(erste);
		// Noch in der Liste: weiterhin Dublette, über Id wie über Identität.
		assert.equal(einfuegen(erste.liste, i, k, msg('20'), 2), null);
		assert.equal(einfuegen(erste.liste, i, k, msg('99', { krypto_id: 'k20' }), 2), null);
		// Weggekappt: weder die Id noch die Identität gelten als bekannt.
		const zurueck = einfuegen(erste.liste, i, k, msg('99', { krypto_id: 'k10' }), 3);
		assert.ok(zurueck, 'die gekappte Nachricht darf wieder aufgenommen werden');
		assert.deepEqual(ids(zurueck.liste), ['20', '30', '99']);
	});

	it('kappt auch dann sauber, wenn die neue Nachricht selbst die älteste ist', () => {
		const i = new Set(['20', '30']);
		const k = new Set([ident('k20'), ident('k30')]);
		const r = einfuegen(
			[msg('20', { krypto_id: 'k20' }), msg('30', { krypto_id: 'k30' })],
			i,
			k,
			msg('10', { krypto_id: 'k10' }),
			2
		);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['20', '30']);
		assert.deepEqual([...i].sort(), ['20', '30']);
		assert.deepEqual([...k].sort(), [ident('k20'), ident('k30')]);
	});
});

describe('Nachrichtenliste: Echo-Ersatz und Lücke — die Mengen', () => {
	it('echoErsetzen meldet Id und Identität der tmp-Kopie auf das Echo um', () => {
		const tmp = msg('tmp-1', { nonce: 'n' });
		const echo = msg('1790000000000000001', { nonce: 'n', krypto_id: '1790000000000000001' });
		const i = new Set(['tmp-1']);
		const k = identitaetenVon([tmp]);
		echoErsetzen(i, k, tmp, echo);
		assert.deepEqual([...i], ['1790000000000000001']);
		assert.deepEqual([...k], [ident('1790000000000000001')]);
		// Eine spätere Kopie derselben Nachricht unter fremder Id ist eine Dublette.
		const spaeter = msg('120000000000000001', { krypto_id: '1790000000000000001' });
		assert.equal(einfuegen([echo], i, k, spaeter, 100), null);
	});

	it('mengenNachLuecke: ohne Kappen bleiben Grabsteine stehen, die neuen kommen dazu', () => {
		// `remove` lässt die Identität einer gelöschten Nachricht stehen.
		const i = new Set(['10']);
		const k = new Set([ident('10'), ident('weg')]);
		mengenNachLuecke(i, k, [msg('10'), msg('20')], [], new Set());
		assert.deepEqual([...i].sort(), ['10', '20']);
		assert.deepEqual([...k].sort(), [ident('10'), ident('20'), ident('weg')]);
	});

	it('mengenNachLuecke: nach dem Kappen nur noch, was in der Liste steht — und die Grabsteine', () => {
		const i = new Set(['10', '20']);
		const k = new Set([ident('10'), ident('20'), ident('weg'), ident('tot')]);
		mengenNachLuecke(i, k, [msg('20'), msg('30')], [msg('10')], new Set([ident('tot')]));
		assert.deepEqual([...i].sort(), ['20', '30']);
		assert.deepEqual([...k].sort(), [ident('20'), ident('30'), ident('tot')]);
	});
});

// Die Grabstein-Fälle stammen von main (243e9164, d05ac5d1) und führten dort
// blosse `krypto_id`s. Auf diesem Stand sind Dublettenmenge und Grabsteine
// Identitäten (Autor + Kennung, `verlauf/identitaet.ts`): ein Grabstein ohne
// Autor könnte die Nachricht eines anderen Autors unter derselben Kennung
// verdecken. Die Fälle prüfen deshalb dasselbe Verhalten mit `ident(…)`, dazu
// kommt der Fälschungsfall am Ende.
describe('Nachrichtenliste: Grabsteine gelöschter Nachrichten', () => {
	/** Drei Nachrichten mit den krypto_ids `k1` bis `k3`, samt passenden Mengen. */
	function dreiNachrichten() {
		const liste = [msg('10', { krypto_id: 'k1' }), msg('20', { krypto_id: 'k2' }), msg('30', { krypto_id: 'k3' })];
		return {
			liste,
			ids: new Set(['10', '20', '30']),
			krypto: new Set([ident('k1'), ident('k2'), ident('k3')]),
			begraben: new Set<string>()
		};
	}

	it('entfernen streicht die Id, lässt die Identität als Grabstein stehen und vermerkt sie', () => {
		const { liste, ids: i, krypto, begraben } = dreiNachrichten();
		const r = entfernen(liste, i, krypto, begraben, '20');
		assert.ok(r);
		assert.deepEqual(ids(r), ['10', '30']);
		assert.deepEqual([...i].sort(), ['10', '30']);
		assert.ok(krypto.has(ident('k2')), 'der Grabstein bleibt in der Dublettenmenge');
		assert.deepEqual([...begraben], [ident('k2')]);
		assert.equal(liste.length, 3, 'die Eingabeliste bleibt unverändert');
	});

	it('entfernen: eine Nachricht ohne krypto_id setzt keinen Grabstein, eine unbekannte ergibt null', () => {
		const liste = [msg('10'), msg('20')];
		const i = new Set(['10', '20']);
		const begraben = new Set<string>();
		assert.deepEqual(ids(entfernen(liste, i, new Set(), begraben, '10') ?? []), ['20']);
		assert.equal(begraben.size, 0);
		assert.equal(entfernen(liste, i, new Set(), begraben, '99'), null);
		assert.deepEqual([...i].sort(), ['20'], 'die unbekannte Id lässt die Mengen unberührt');
	});

	it('der Grabstein überlebt das Kappen beim Einfügen: die Kopie unter anderer Id bleibt draußen', () => {
		const { liste, ids: i, krypto, begraben } = dreiNachrichten();
		let aktuell = entfernen(liste, i, krypto, begraben, '20') ?? [];
		// Zwei neue Nachrichten: die zweite überschreitet die Kappung (3) und
		// wirft '10' hinaus — der Abgleich baut die Mengen aus der Liste neu.
		aktuell = einfuegen(aktuell, i, krypto, msg('40'), 3, begraben)?.liste ?? [];
		const gekappt = einfuegen(aktuell, i, krypto, msg('50'), 3, begraben);
		assert.ok(gekappt);
		assert.deepEqual(ids(gekappt.liste), ['30', '40', '50']);
		assert.deepEqual(ids(gekappt.verworfen), ['10']);
		// Die Kopie der gelöschten Nachricht (anderes Gerät, andere lokale Id):
		assert.equal(
			einfuegen(gekappt.liste, i, krypto, msg('25', { krypto_id: 'k2' }), 3, begraben),
			null,
			'eine gelöschte Nachricht kehrt nach dem Kappen nicht zurück'
		);
		// Eine bloß weggekappte (nie gelöschte) darf dagegen wiederkommen.
		assert.ok(einfuegen(gekappt.liste, i, krypto, msg('15', { krypto_id: 'k1' }), 4, begraben));
	});

	it('der Grabstein überlebt das Kappen beim Voranstellen älterer Historie', () => {
		const liste = [msg('30', { krypto_id: 'k3' }), msg('40', { krypto_id: 'k4' })];
		const i = new Set(['30', '40']);
		const krypto = new Set([ident('k3'), ident('k4'), ident('k2')]);
		const begraben = new Set([ident('k2')]);
		const r = vorneAnfuegen(liste, i, krypto, [msg('10', { krypto_id: 'k1' }), msg('20')], 3, begraben);
		assert.ok(r);
		assert.deepEqual(ids(r.liste), ['20', '30', '40']);
		assert.deepEqual(ids(r.verworfen), ['10']);
		assert.ok(krypto.has(ident('k2')), 'der Abgleich hat den Grabstein zurückgelegt');
		assert.equal(vorneAnfuegen(r.liste, i, krypto, [msg('5', { krypto_id: 'k2' })], 3, begraben), null);
	});

	it('der Abgleich baut krypto weiter aus der Liste: der Grabstein hängt allein an der durchgereichten Menge', () => {
		const { liste, ids: i, krypto } = dreiNachrichten();
		// Dieselbe Folge, aber der Aufrufer reicht keine Grabsteine durch.
		entfernen(liste, i, krypto, new Set<string>(), '20');
		einfuegen(liste.filter((m) => m.id !== '20'), i, krypto, msg('40'), 2);
		assert.equal(krypto.has(ident('k2')), false);
	});

	it('identitaetenVon legt die Grabsteine zu den Identitäten der Liste', () => {
		const s = identitaetenVon([msg('1', { krypto_id: 'a' }), msg('2')], new Set([ident('tot')]));
		assert.deepEqual([...s].sort(), [ident('2'), ident('a'), ident('tot')]);
		assert.deepEqual([...identitaetenVon([msg('1', { krypto_id: 'a' })])], [ident('a')]);
	});

	it('Autor-Bindung: der Grabstein einer gelöschten Nachricht verdeckt keine fremde unter derselben Kennung', () => {
		// Bob schickt eine Nachricht unter der Kennung K einer Nachricht von
		// Alice und löscht sie. Alices Nachricht (dieselbe Kennung, anderer
		// Autor) muss danach weiter aufgenommen werden — ob sie live kommt,
		// beim Hochscrollen oder beim Wiederöffnen.
		const bobs = msg('20', { krypto_id: 'K', author_id: 'bob' });
		const liste = [msg('10'), bobs];
		const i = new Set(['10', '20']);
		const krypto = identitaetenVon(liste);
		const begraben = new Set<string>();
		const rest = entfernen(liste, i, krypto, begraben, '20') ?? [];
		assert.deepEqual([...begraben], [ident('K', 'bob')]);
		const alices = msg('25', { krypto_id: 'K', author_id: 'alice' });
		assert.ok(einfuegen(rest, i, krypto, alices, 100, begraben), 'live');
		const aelter = msg('5', { krypto_id: 'K', author_id: 'alice' });
		const hoch = vorneAnfuegen(rest, new Set(['10']), identitaetenVon(rest, begraben), [aelter], 100, begraben);
		assert.ok(hoch, 'Hochscrollen');
		assert.deepEqual(ids(ohneGrabsteine([msg('10'), alices], begraben)), ['10', '25'], 'Wiederöffnen');
		// Bobs eigene Kopie unter anderer Id bleibt dagegen weg.
		assert.equal(einfuegen(rest, i, krypto, msg('26', { krypto_id: 'K', author_id: 'bob' }), 100, begraben), null);
	});
});

describe('Nachrichtenliste: Grabsteine beim erneuten Laden', () => {
	it('ohneGrabsteine nimmt Nachrichten heraus, deren Identität ein Grabstein ist', () => {
		const liste = [
			msg('10', { krypto_id: 'tot' }), // Kopie eines Empfängergeräts unter lokaler Zustellungs-Id
			msg('20'),
			msg('tot2'), // Kopie des Autors ohne krypto_id: die eigene Id ist die kanonische
			msg('30', { krypto_id: 'lebt' })
		];
		const r = ohneGrabsteine(liste, new Set([ident('tot'), ident('tot2')]));
		assert.deepEqual(ids(r), ['20', '30']);
		assert.equal(liste.length, 4, 'die Eingabeliste bleibt unverändert');
	});

	it('ohneGrabsteine gibt ohne Treffer dieselbe Liste zurück', () => {
		const liste = [msg('10', { krypto_id: 'a' }), msg('20')];
		assert.equal(ohneGrabsteine(liste, new Set()), liste);
		assert.equal(ohneGrabsteine(liste, new Set([ident('fremd')])), liste);
		assert.equal(ohneGrabsteine(liste, new Set([ident('a', 'b')])), liste, 'derselbe Schlüssel eines anderen Autors');
	});

	it('Wiederöffnen: löschen, Liste neu laden, Nachzug-Seite mit der Kopie — die Kopie bleibt weg', () => {
		// Zustand des Stores: zwei Nachrichten, die mittlere wird gelöscht.
		const liste = [msg('10'), msg('20', { krypto_id: 'k2' }), msg('30')];
		const i = new Set(['10', '20', '30']);
		const krypto = identitaetenVon(liste);
		const begraben = new Set<string>();
		assert.ok(entfernen(liste, i, krypto, begraben, '20'));
		// Wiederöffnen: `setInitial` bekommt den Verlauf, der die Nachricht noch
		// (als Kopie unter anderer Id) enthält, und baut die Mengen neu.
		const geladen = ohneGrabsteine([msg('10'), msg('25', { krypto_id: 'k2' }), msg('30')], begraben);
		assert.deepEqual(ids(geladen), ['10', '30']);
		const ids2 = new Set(geladen.map((m) => m.id));
		const krypto2 = identitaetenVon(geladen, begraben);
		// Der Archiv-Nachzug liefert danach noch einmal die Kopie, in einer Seite vor dem Fenster.
		assert.equal(vorneAnfuegen(geladen, ids2, krypto2, [msg('5', { krypto_id: 'k2' })], 100, begraben), null);
		// Eine lebende Nachricht aus derselben Seite kommt dagegen durch.
		const r = vorneAnfuegen(geladen, ids2, krypto2, [msg('5', { krypto_id: 'k2' }), msg('6')], 100, begraben);
		assert.ok(r);
		assert.deepEqual(ids(r.neu), ['6']);
	});
});
