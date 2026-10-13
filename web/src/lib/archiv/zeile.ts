/**
 * Der Klartext-Kern einer Archiv-Zeile (Gruppen-Erweiterung 2026-10-05).
 *
 * Ein einziges JSON — kompakte Ein-Buchstaben-Felder, die Nutzlast-Grenze
 * je Zeile bleibt klein (32 768 Base64-Zeichen):
 *
 *   i  Nachrichten-Id          t  Text
 *   a  Absender-Konto-Id       z  Sende-Zeitpunkt (ISO)
 *   r  Antwort-auf-Id?         anh  Anhang-Angaben?
 *
 * **Anhänge reisen als ANGABEN mit, die Bytes nicht** (Entscheidung
 * 03.10.: Durchlauferhitzer bleibt) — ein anderes Gerät rendert daraus die
 * Platzhalter-Kachel und holt die Bytes lokal, aus der privaten
 * Cloud-Sicherung oder gar nicht (`krypto/anhangHolen.ts`).
 *
 * Vor der Gruppen-Erweiterung trug die Zeile statt `anh` nur die Anzahl
 * (`v`) — `leseZeilenKlar` toleriert beide Fassungen, es gibt dort nichts
 * anzuzeigen.
 *
 * **Den Autor `a` schreibt der Einliefernde selbst hinein** — und einliefern
 * darf jedes Kanalmitglied. Seit 2026-10-12 nennt der Server deshalb zu jeder
 * Zeile, wer sie eingeliefert hat (`user_id`, aus der Anmeldung), und
 * `leseZeile` verwirft eine Zeile, deren `a` nicht dazu passt. Vorher konnte
 * ein Mitglied eine Zeile mit Namen und Kennung einer fremden Nachricht
 * einliefern, und auf einem Frischgerät stand sie als deren Nachricht da.
 *
 * **Grabstein-Zeile** `{ g, a, z }`: der Autor löscht seine eigene Nachricht
 * mit der kanonischen Kennung `g`. Der Server kann keine Zeile je Nachricht
 * löschen — welche Zeile zu welcher Nachricht gehört, steht nur in der
 * Nutzlast. Sie zählt nur, wenn ihr Einlieferer ihr Autor ist, und trifft nur
 * Sätze dieses Autors (`verlauf/identitaet.ts`). Ohne `i` und `t` mit Absicht:
 * ein älterer Klient legt sie dadurch nicht als leere Nachricht ab, sondern
 * verwirft sie still (`verlauf/satz.ts::zuSatz` verlangt beides).
 *
 * **Bearbeitungs-Zeile** `{ e, a, t, z }` (seit 2026-10-14): der Autor setzt
 * den Text seiner Nachricht mit der kanonischen Kennung `e` auf `t`, `z` ist
 * die Bearbeitungszeit. Dieselbe Bindung wie beim Grabstein; sie ergänzt nur
 * unbearbeitete Sätze (`verlauf/archivBearbeitung.ts`). Ohne `i`: ein älterer
 * Klient verwirft sie still wie die Grabstein-Zeile.
 *
 * **Jede Kennung einer Zeile wählt der Einliefernde frei** (Gegenprüfung
 * 2026-10-12, Fund 1): `i`, `g`, `r`, `a` und die Anhang-IDs. `leseZeile`
 * nimmt nur an, was die Form einer Kennung hat
 * (`verlauf/identitaet.ts::istGueltigeKennung`); eine Grabstein-Zeile `{g:"x"}`
 * landete sonst als Eintrag im Grabstein-Register und als Stein in der
 * Sicherung, an dem jede Wiederherstellung des Kanals scheiterte.
 *
 * **Wo eine Zeile lokal liegt** (Gegenprüfung G2-3/R1, 2026-10-14). Die
 * Kennung `i` wählt der Einliefernde frei. Lag jede Zeile lokal unter ihrer
 * `i`, lieferte Bob `{i: K_alice, a: Bob}` ein und besetzte auf jedem Gerät,
 * das Alices Nachricht noch nicht hielt, ihren Platz: ein anderer Autor unter
 * demselben Schlüssel wird nie überschrieben (`verlauf/satz.ts::satzErgaenzen`),
 * also fiel danach dort alles weg, was Alices Nachricht nachliefern konnte —
 * ihre Archiv-Zeile, ihr Satz aus der eigenen Sicherung und aus der Kopplung.
 * Deshalb liegt die Zeile eines ANDEREN Einlieferers unter ihrer Zeilen-ID,
 * und die vergibt seit diesem Tag der Server (`routes/archiv.py`, die Id im
 * Körper wird verworfen); `i` reist nur als `krypto_id` mit und bindet über
 * die Identität (Autor = Einlieferer) an die Nachricht. Die Zeilen-ID kann
 * der Einliefernde nicht wählen, und mit den Zustellungs-IDs, unter denen
 * Empfangenes liegt, teilt sie die Quelle (Snowflakes des chat-gateway).
 *
 * Zwei Ausnahmen behalten `i`. (1) Die EIGENE Zeile: niemand sonst liefert
 * unter meinem Namen ein, und unter `i` liegt mein Satz vom Sendegerät; unter
 * der Zeilen-ID stünde er doppelt, und eine eigene Bearbeitung träfe nur eine
 * der beiden Kopien (`cloudNachrichtAktionen.ts` schreibt den angezeigten
 * Satz um). (2) Die Bestandszeile ohne Einlieferer: ihre Zeilen-ID wählte noch
 * der Klient, sie wäre kein besserer Platz. Ein Satz daraus ist `ungeprueft`
 * und weicht jedem geprüften unter seinem Schlüssel, auch dem eines anderen
 * Autors (`satz.ts::satzErgaenzen`).
 *
 * Ältere Klienten legen weiter unter `i` ab und tragen die Lücke weiter; ihre
 * Einlieferungen nimmt der Server unverändert an.
 *
 * Laufzeit-Importe nur mit `.ts`-Endung (Node-Testläufer-Regel, s.
 * `verlauf/schema.ts`); sonst nur Typen.
 */
import type { Message } from '../api/types';
import type { AnhangAngabe } from '../krypto/nachrichtNutzlast';
// .ts-Endung: dieses Modul läuft im Node-Testläufer (Konvention s.
// `verlauf/schema.ts`) — der Bundler akzeptiert die Endung unverändert.
import { attachmentZuAngabe, anhangAngabeZuAttachment } from '../krypto/anhangAnzeige.ts';
import { istGueltigeKennung } from '../verlauf/identitaet.ts';
import type { ArchivBearbeitung } from '../verlauf/archivBearbeitung';

type ArchivZeileKlar = {
	i: string;
	t: string;
	a: string;
	z: string;
	r?: string;
	anh?: AnhangAngabe[];
};

type GrabsteinZeileKlar = { g: string; a: string; z: string };

type BearbeitungZeileKlar = { e: string; a: string; t: string; z: string };

/** Eine gesendete Nachricht → Klartext-Bytes für die Archiv-Zeile. */
export function baueZeilenKlar(nachricht: Message): Uint8Array {
	const klar: ArchivZeileKlar = {
		i: nachricht.id,
		t: nachricht.content,
		a: nachricht.author_id,
		z: nachricht.created_at,
		...(nachricht.reply_to_id ? { r: nachricht.reply_to_id } : {}),
		...(nachricht.attachments?.length
			? { anh: nachricht.attachments.map(attachmentZuAngabe) }
			: {})
	};
	return new TextEncoder().encode(JSON.stringify(klar));
}

/** Archiv-Zeilen-Klartext → Nachricht für den lokalen Verlauf. Die Kanal-Id
 *  kommt aus der Zeilen-Position beim Server, nicht aus der Nutzlast.
 *  `krypto_id` = kanonische Autoren-Id — live empfangene Nachrichten tragen
 *  die zustellungs-eigene Id als `id` und dedupeln über `krypto_id` gegen
 *  Kopien aus Sicherung/Archiv (`messages.svelte.ts::prepend`, Befund
 *  2026-09-17); ohne dieses Feld erschien dieselbe Nachricht doppelt. */
export function leseZeilenKlar(kanalId: string, roh: string): Message {
	const inhalt = JSON.parse(roh) as ArchivZeileKlar;
	return zuNachricht(kanalId, inhalt, inhalt.i);
}

function zuNachricht(kanalId: string, inhalt: ArchivZeileKlar, lokaleId: string): Message {
	return {
		id: lokaleId,
		channel_id: kanalId,
		author_id: inhalt.a,
		content: inhalt.t,
		nonce: null,
		reply_to_id: inhalt.r ?? null,
		created_at: inhalt.z,
		verschluesselt: true,
		krypto_id: inhalt.i,
		...(inhalt.anh?.length
			? { attachments: inhalt.anh.map(anhangAngabeZuAttachment) }
			: {})
	};
}

/** Die Grabstein-Zeile des Autors für seine Nachricht mit der kanonischen
 *  Kennung `kennung` (s. Modulkopf). */
export function baueGrabsteinKlar(kennung: string, autorId: string, zeit: string): Uint8Array {
	const klar: GrabsteinZeileKlar = { g: kennung, a: autorId, z: zeit };
	return new TextEncoder().encode(JSON.stringify(klar));
}

/** Eine angenommene Grabstein-Zeile: `autorId` löscht seine Nachricht mit
 *  der kanonischen Kennung `kennung`. */
export type Grabstein = { art: 'grabstein'; autorId: string; kennung: string };

/** Die Bearbeitungs-Zeile des Autors: neuer Text `inhalt` für seine Nachricht
 *  mit der kanonischen Kennung `kennung` (s. Modulkopf). */
export function baueBearbeitungKlar(
	kennung: string,
	autorId: string,
	inhalt: string,
	zeit: string
): Uint8Array {
	const klar: BearbeitungZeileKlar = { e: kennung, a: autorId, t: inhalt, z: zeit };
	return new TextEncoder().encode(JSON.stringify(klar));
}

/** Eine angenommene Bearbeitungs-Zeile. */
export type Bearbeitung = { art: 'bearbeitung' } & ArchivBearbeitung;

/** Eine Nachricht aus dem Archiv, bei einer Bestandszeile mit der Marke
 *  `archiv_ungeprueft` (`verlauf/satz.ts::zuSatz` übernimmt sie in den Satz). */
export type ArchivNachricht = Message & { archiv_ungeprueft?: true };

/** Was eine Archiv-Zeile ist, nachdem `leseZeile` sie angenommen hat. */
export type ArchivEintrag =
	| { art: 'nachricht'; nachricht: ArchivNachricht }
	| Grabstein
	| Bearbeitung;

/**
 * Bestandszeilen ohne Einlieferer (eingeliefert vor Migration 0103) werden
 * ÜBERGANGSWEISE noch angenommen — wie bisher, ohne Prüfung des Autors.
 * Begründung: neue Zeilen tragen den Einlieferer immer, eine Fälschung ist
 * damit nur noch in Zeilen möglich, die schon vor der Umstellung lagen, und
 * die räumt der 120-Tage-Sweeper bis spätestens Februar 2027 ab. Sie zu
 * verwerfen kostete dagegen jedem Frischgerät ohne Sicherung den ganzen
 * Archiv-Verlauf bis zur Umstellung. Eine Bestandszeile kann trotzdem nichts
 * an einem liegenden Satz ändern als seine Kennung
 * (`verlauf/satz.ts::satzErgaenzen`), und eine Grabstein- oder
 * Bearbeitungs-Zeile gibt es nur mit Einlieferer. Der Satz aus einer Bestandszeile trägt `ungeprueft` und
 * wird nie eigene Wahrheit: keine Erstsicherung, keine Kopplung, jeder
 * geprüfte Satz ersetzt ihn (`verlauf/herkunft.ts`, Gegenprüfung 2026-10-12,
 * Fund 4). Produktentscheidung, offen gemeldet am 2026-10-12.
 */
const BESTANDSZEILEN_ANNEHMEN = true;

/** Was der Server zu einer Zeile sagt, plus das lesende Konto. */
export type ZeilenHerkunft = {
	/** Wer sie eingeliefert hat (`user_id`), `null` bei einer Bestandszeile. */
	einlieferer: string | null;
	/** Ihre Zeilen-ID, vom Server vergeben (s. Modulkopf). */
	zeilenId: string;
	/** Das angemeldete Konto, das die Zeile liest. */
	konto: string;
};

/**
 * Klartext einer Zeile plus ihre Herkunft → Eintrag, oder `null`: die Zeile
 * wird verworfen. Verworfen wird eine Zeile, deren Autor nicht ihr
 * Einlieferer ist, und jede Grabstein- oder Bearbeitungs-Zeile ohne bekannten
 * Einlieferer. Eine
 * Nachricht liegt danach unter der Zeilen-ID, wenn ein anderes Konto sie
 * eingeliefert hat, sonst unter `i` (s. Modulkopf). Wirft bei kaputtem JSON.
 */
export function leseZeile(
	kanalId: string,
	roh: string,
	{ einlieferer, zeilenId, konto }: ZeilenHerkunft
): ArchivEintrag | null {
	const inhalt = JSON.parse(roh) as Partial<
		ArchivZeileKlar & GrabsteinZeileKlar & BearbeitungZeileKlar
	>;
	const vomAutor = einlieferer !== null && inhalt.a === einlieferer;
	if (inhalt.g !== undefined) {
		return vomAutor && istGueltigeKennung(inhalt.g)
			? { art: 'grabstein', autorId: einlieferer, kennung: inhalt.g }
			: null;
	}
	if (inhalt.e !== undefined) {
		const { e, t, z } = inhalt;
		return vomAutor && istGueltigeKennung(e) && typeof t === 'string' && typeof z === 'string'
			? { art: 'bearbeitung', autorId: einlieferer, kennung: e, inhalt: t, bearbeitetAm: z }
			: null;
	}
	const angenommeneBestandszeile = einlieferer === null && BESTANDSZEILEN_ANNEHMEN;
	if (!vomAutor && !angenommeneBestandszeile) return null;
	if (!istGueltigeKennung(inhalt.i) || !istGueltigeKennung(inhalt.a)) return null;
	const lokaleId = einlieferer === null || einlieferer === konto ? inhalt.i : zeilenId;
	if (!istGueltigeKennung(lokaleId)) return null;
	const nachricht: ArchivNachricht = zuNachricht(kanalId, ohneUngueltigeBezuege(inhalt), lokaleId);
	// Den Autor einer Bestandszeile hat niemand geprüft — der Satz daraus
	// wird nie eigene Wahrheit (`verlauf/herkunft.ts`, Fund 4).
	if (angenommeneBestandszeile) nachricht.archiv_ungeprueft = true;
	return { art: 'nachricht', nachricht };
}

/** Der Antwortbezug und die Anhänge einer Zeile, soweit sie Kennungen sind —
 *  ein ungültiger Bezug fällt weg, ein Anhang ohne gültige ID ebenso (dieselbe
 *  Regel wie `krypto/nachrichtNutzlast.ts::leseAnhang`). Der Text bleibt. */
function ohneUngueltigeBezuege(inhalt: Partial<ArchivZeileKlar>): ArchivZeileKlar {
	const { r, anh, ...rest } = inhalt as ArchivZeileKlar;
	return {
		...rest,
		...(istGueltigeKennung(r) ? { r } : {}),
		anh: Array.isArray(anh) ? anh.filter((a) => istGueltigeKennung(a?.id)) : []
	};
}
