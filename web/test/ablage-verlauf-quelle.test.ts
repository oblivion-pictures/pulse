import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { AblageSchreiber } from '../src/lib/ablage/schreiber.ts';
import { nachziehen } from '../src/lib/ablage/nachzieher.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';
import { ausWire, kodiereNachricht, leseNachricht } from '../src/lib/ablage/nutzlast.ts';
import { TYP_KLARTEXT_JSON } from '../src/lib/ablage/format.ts';
import {
	festigbar,
	haltegrenze,
	REIFEZEIT_MS,
	SNOWFLAKE_BEREICH_ENDE,
	verlaufQuelle,
	type FestigungsSatz,
} from '../src/lib/ablage/verlaufQuelle.ts';
import { SNOWFLAKE_EPOCH_MS, SNOWFLAKE_ZEIT_SHIFT } from '../src/lib/utils/snowflakeZeit.ts';
import { zuSatz } from '../src/lib/verlauf/satz.ts';
import { ART_GRUPPENNACHRICHT } from '../src/lib/krypto/gruppe/gruppenNutzlast.ts';
import type { PostfachZustellung } from '../src/lib/api/postfach.ts';
import type { Message } from '../src/lib/api/types.ts';

/**
 * `ablage/verlaufQuelle.ts` — die Quelle der Kanal-Festigung seit 2026-10-17.
 *
 * Der Fehler davor: die Festigung las nur den OFFENEN Postfach-Bestand, der
 * Empfangsweg quittiert aber jede Zustellung, sobald sie im Verlauf liegt
 * (`krypto/empfangen.ts`). Der erste Fall hier ist genau diese Lage — der
 * Empfang ist durch, das Postfach leer, die Nachricht steht nur noch im
 * Verlauf. Die alte Quelle festigte daraus nichts (E2E-Nachweis:
 * `tests/e2e/e2e-ablage-kanal.spec.ts`, „landet im Laufwerk des Besitzers").
 *
 * Der Verlauf ist hier eine Nachbildung des IndexedDB-Lesers
 * (`verlauf/dbAufsteigend.ts`): dieselbe Zusage — aufsteigend, `nach < id <
 * bis`, `passt` VOR dem Zählen —, die Sätze aber aus dem echten `zuSatz`
 * gebaut, also in genau der Form, in der der Empfangsweg sie ablegt.
 */

const KANAL = '7000';
const FREMDER_KANAL = '7001';
const KONTO = 'konto-besitzer';
/** Die Uhr der meisten Fälle: Ids wie '100' tragen die Zeit kurz nach der
 *  Snowflake-Epoche und sind damit längst reif. */
const JETZT = () => Date.now();

/** Die Snowflake einer Zustellung, die zur Server-Zeit `ms` entstand. */
function snowflakeUm(ms: number, folge = 0): string {
	return String(((BigInt(ms) - SNOWFLAKE_EPOCH_MS) << SNOWFLAKE_ZEIT_SHIFT) + BigInt(folge));
}

/** Eine eigene Nachricht: lokale Id, 19 Stellen (`krypto/lokaleNachrichtId.ts`). */
const LOKALE_ID = '1760700000000123456';

function empfangen(id: string, overrides: Partial<Message> = {}): Message {
	// Dieselben Felder wie `krypto/empfangeneNachricht.ts::baueEmpfangeneNachricht`:
	// Id = Zustellungs-Id, verschluesselt, mit geraeteuebergreifender Kennung.
	return {
		id,
		channel_id: KANAL,
		author_id: 'nutzer-bob',
		content: `Klartext ${id}`,
		nonce: null,
		reply_to_id: null,
		created_at: '2026-10-17T10:00:00Z',
		verschluesselt: true,
		krypto_id: `17606${id.padStart(14, '0')}`,
		...overrides,
	};
}

function zustellung(id: string, overrides: Partial<PostfachZustellung> = {}): PostfachZustellung {
	return {
		id,
		channel_id: KANAL,
		absender_device_pubkey: 'geraet-bob',
		absender_curve25519: null,
		absender_user_id: 'nutzer-bob',
		art: ART_GRUPPENNACHRICHT,
		daten: `geheimtext-${id}`,
		groesse: 12,
		...overrides,
	};
}

/** Nachbildung des lokalen Verlaufs samt Leser — s. Dateikopf. */
function verlauf() {
	const saetze = new Map<string, FestigungsSatz & { kontoId: string }>();
	return {
		ablegen(nachricht: Message, extra: Partial<FestigungsSatz> = {}, konto = KONTO) {
			const satz = zuSatz(KANAL, nachricht, konto);
			assert.ok(satz, `zuSatz verwarf ${nachricht.id}`);
			saetze.set(satz.nachrichtId, { ...satz, ...extra });
		},
		lesen: async (nach: bigint | null, bis: bigint, limit: number) =>
			[...saetze.values()]
				.filter((s) => s.kontoId === KONTO && festigbar(s))
				.filter((s) => {
					const id = BigInt(s.nachrichtId);
					return (nach === null || id > nach) && id < bis;
				})
				.sort((a, b) => (BigInt(a.nachrichtId) < BigInt(b.nachrichtId) ? -1 : 1))
				.slice(0, limit),
	};
}

async function laufwerkIds(ablage: ReturnType<typeof speicherAdapter>): Promise<bigint[]> {
	return (await leseVerlauf(ablage)).rahmen.map((r) => r.eintragsId);
}

describe('Ablage-Verlaufsquelle', () => {
	it('festigt, was der Empfangsweg schon quittiert hat (Postfach leer) — genau einmal', async () => {
		const v = verlauf();
		v.ablegen(empfangen('100'));
		v.ablegen(empfangen('101'));
		const quelle = verlaufQuelle(KANAL, async () => [], v.lesen, JETZT);

		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, KANAL);
		const erster = await nachziehen(schreiber, quelle);
		assert.equal(erster.festigt, 2);
		assert.deepEqual(await laufwerkIds(ablage), [100n, 101n]);

		// Zweite Runde, neuer Schreiber wie in `kanalFestigung.ts` (Bestand
		// zuerst aufnehmen): nichts doppelt.
		const zweiterSchreiber = new AblageSchreiber(ablage, KANAL);
		await zweiterSchreiber.bestandAufnehmen();
		const zweiter = await nachziehen(zweiterSchreiber, quelle);
		assert.equal(zweiter.festigt, 0);

		// Eine später empfangene Nachricht kommt dahinter, wieder einmal.
		v.ablegen(empfangen('102'));
		await nachziehen(zweiterSchreiber, quelle);
		assert.deepEqual(await laufwerkIds(ablage), [100n, 101n, 102n]);
		const rahmen = (await leseVerlauf(ablage)).rahmen;
		assert.ok(rahmen.every((r) => r.typ === TYP_KLARTEXT_JSON));
		assert.deepEqual(
			rahmen.map((r) => leseNachricht(r.nutzlast).inhalt),
			['Klartext 100', 'Klartext 101', 'Klartext 102'],
		);
	});

	it('legt dieselbe Nutzlast ab wie die Postfach-Quelle aus der empfangenen Nachricht', async () => {
		// Ein bestehendes Laufwerk setzt nahtlos fort: Rahmen-Id und Nutzlast
		// sind dieselben wie bisher (`ausWire` der geöffneten Nachricht).
		const nachricht = empfangen('200', {
			reply_to_id: '150',
			edited_at: null,
			attachments: [
				{ id: '9001', filename: 'bild.png', mime: 'image/png', size: 42, url: 'https://kurzlebig' },
			],
		});
		const v = verlauf();
		v.ablegen(nachricht);
		const [eintrag] = await verlaufQuelle(KANAL, async () => [], v.lesen, JETZT).holen(null, 10);
		assert.equal(eintrag.id, 200n);
		assert.deepEqual(
			leseNachricht(eintrag.nutzlast),
			leseNachricht(kodiereNachricht(ausWire(nachricht))),
		);
	});

	it('setzt hinter dem Wasserzeichen eines bestehenden Laufwerks fort', async () => {
		const ablage = speicherAdapter();
		const alt = new AblageSchreiber(ablage, KANAL);
		const altQuelle = verlauf();
		altQuelle.ablegen(empfangen('300'));
		altQuelle.ablegen(empfangen('301'));
		await nachziehen(alt, verlaufQuelle(KANAL, async () => [], altQuelle.lesen, JETZT));

		const v = verlauf();
		for (const id of ['299', '300', '301', '302']) v.ablegen(empfangen(id));
		const schreiber = new AblageSchreiber(ablage, KANAL);
		await schreiber.bestandAufnehmen();
		const bericht = await nachziehen(schreiber, verlaufQuelle(KANAL, async () => [], v.lesen, JETZT));
		// 299 liegt unter dem Wasserzeichen — ein append-only-Log kann es nicht
		// mehr aufnehmen; deshalb die Haltegrenze unten.
		assert.equal(bericht.festigt, 1);
		assert.deepEqual(await laufwerkIds(ablage), [300n, 301n, 302n]);
	});

	it('hält vor einer noch offenen Zustellung des Kanals an und holt sie später in Reihenfolge nach', async () => {
		// 402 ist zugestellt, aber noch nicht zu öffnen (Schlüssel fehlt) — sie
		// liegt im Postfach. 403 ist schon empfangen und quittiert.
		const v = verlauf();
		v.ablegen(empfangen('401'));
		v.ablegen(empfangen('403'));
		let offen = [zustellung('402')];
		const quelle = verlaufQuelle(KANAL, async () => offen, v.lesen, JETZT);

		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, KANAL);
		await nachziehen(schreiber, quelle);
		assert.deepEqual(await laufwerkIds(ablage), [401n]);

		// Der Schlüssel kommt nach, der Empfangsweg legt 402 ab und quittiert.
		v.ablegen(empfangen('402'));
		offen = [];
		await nachziehen(schreiber, quelle);
		assert.deepEqual(await laufwerkIds(ablage), [401n, 402n, 403n]);
	});

	it('festigt nur Gereiftes — eine nach dem Postfach-Blick eingetroffene Zustellung kann keine ältere überholen', async () => {
		// Gegenprüfung 2026-10-17, Befund 1: der Postfach-Blick ist leer, danach
		// kommen 101 (Schlüssel fehlt, bleibt liegen) und 102 (lesbar). Der
		// Empfangsweg legt 102 ab, BEVOR die Festigung den Verlauf liest. Ohne
		// Reifezeit stünde 102 im Log und 101 fiele später darunter.
		let uhr = Date.UTC(2026, 9, 17, 12, 0, 0);
		const z101 = snowflakeUm(uhr - 500, 1);
		const z102 = snowflakeUm(uhr - 400, 2);
		const v = verlauf();
		let offen: PostfachZustellung[] = [];
		const quelle = verlaufQuelle(
			KANAL,
			async () => {
				const bestand = offen;
				// Was nach dem Blick geschieht: 101 liegt, 102 ist schon abgelegt.
				offen = [zustellung(z101)];
				v.ablegen(empfangen(z102));
				return bestand;
			},
			v.lesen,
			() => uhr,
		);
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, KANAL);
		await nachziehen(schreiber, quelle);
		assert.deepEqual(await laufwerkIds(ablage), []);

		// Eine Runde nach der Reifezeit: jetzt hält 101 im Postfach die Grenze.
		uhr += REIFEZEIT_MS + 1_000;
		await nachziehen(schreiber, quelle);
		assert.deepEqual(await laufwerkIds(ablage), []);

		// 101 wird geöffnet und quittiert — beide gehen in Reihenfolge ins Log.
		v.ablegen(empfangen(z101));
		offen = [];
		const quelleDanach = verlaufQuelle(KANAL, async () => [], v.lesen, () => uhr);
		await nachziehen(schreiber, quelleDanach);
		assert.deepEqual(await laufwerkIds(ablage), [BigInt(z101), BigInt(z102)]);
	});

	it('lässt sich von offenen Zustellungen anderer Kanäle und anderer Arten nicht anhalten', () => {
		const offen = [
			zustellung('10', { channel_id: FREMDER_KANAL }),
			zustellung('11', { art: 0 }), // Olm-Sitzungsaufbau, keine Gruppennachricht
			zustellung('50'),
			zustellung('40'),
		];
		assert.equal(haltegrenze(KANAL, offen), 40n);
		assert.equal(haltegrenze(KANAL, offen.slice(0, 2)), SNOWFLAKE_BEREICH_ENDE);
	});

	it('nimmt eigene Nachrichten (lokale Id) nicht auf — das Wasserzeichen bleibt im Snowflake-Bereich', async () => {
		const v = verlauf();
		v.ablegen(empfangen('500'));
		v.ablegen(empfangen(LOKALE_ID, { author_id: 'nutzer-besitzer', krypto_id: LOKALE_ID }));
		const quelle = verlaufQuelle(KANAL, async () => [], v.lesen, JETZT);
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, KANAL);
		await nachziehen(schreiber, quelle);

		// Danach empfangen: muss trotzdem dahinter passen.
		v.ablegen(empfangen('501'));
		await nachziehen(schreiber, quelle);
		assert.deepEqual(await laufwerkIds(ablage), [500n, 501n]);
	});

	it('lässt Grabsteine, Ungeprüftes und Unverschlüsseltes aus — und läuft an einer Seite voller Grabsteine vorbei', async () => {
		const v = verlauf();
		for (let i = 600; i < 610; i++) v.ablegen(empfangen(String(i)), { geloescht: true });
		v.ablegen(empfangen('610'), { ungeprueft: true });
		v.ablegen(empfangen('611', { verschluesselt: false }));
		v.ablegen(empfangen('612'));
		v.ablegen(empfangen('613'), {}, 'fremdes-konto');
		const ablage = speicherAdapter();
		// Eine Seite (limit 3) ist kleiner als der Block der Grabsteine.
		await nachziehen(new AblageSchreiber(ablage, KANAL), verlaufQuelle(KANAL, async () => [], v.lesen, JETZT), {
			limit: 3,
		});
		assert.deepEqual(await laufwerkIds(ablage), [612n]);
	});

	it('prüft die Zusage des Lesers nach: nichts jenseits der Grenze, eine unsortierte Seite verliert nichts', async () => {
		const saetze = ['705', '701', '703', '709', LOKALE_ID].map((id) => {
			const satz = zuSatz(KANAL, empfangen(id), KONTO);
			assert.ok(satz);
			return satz;
		});
		const quelle = verlaufQuelle(KANAL, async () => [zustellung('708')], async () => saetze, JETZT);
		const eintraege = await quelle.holen(700n, 10);
		// Aufsteigend, nur unter der Grenze 708, ohne die lokale Id.
		assert.deepEqual(
			eintraege.map((e) => e.id),
			[701n, 703n, 705n],
		);
	});
});
