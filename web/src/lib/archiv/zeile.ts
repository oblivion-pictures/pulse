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
 * **Jede Kennung einer Zeile wählt der Einliefernde frei** (Gegenprüfung
 * 2026-10-12, Fund 1): `i`, `g`, `r`, `a` und die Anhang-IDs. `leseZeile`
 * nimmt nur an, was die Form einer Kennung hat
 * (`verlauf/identitaet.ts::istGueltigeKennung`); eine Grabstein-Zeile `{g:"x"}`
 * landete sonst als Eintrag im Grabstein-Register und als Stein in der
 * Sicherung, an dem jede Wiederherstellung des Kanals scheiterte.
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

type ArchivZeileKlar = {
	i: string;
	t: string;
	a: string;
	z: string;
	r?: string;
	anh?: AnhangAngabe[];
};

type GrabsteinZeileKlar = { g: string; a: string; z: string };

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
	return zuNachricht(kanalId, JSON.parse(roh) as ArchivZeileKlar);
}

function zuNachricht(kanalId: string, inhalt: ArchivZeileKlar): Message {
	return {
		id: inhalt.i,
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

/** Was eine Archiv-Zeile ist, nachdem `leseZeile` sie angenommen hat. */
export type ArchivEintrag = { art: 'nachricht'; nachricht: Message } | Grabstein;

/**
 * Bestandszeilen ohne Einlieferer (eingeliefert vor Migration 0102) werden
 * ÜBERGANGSWEISE noch angenommen — wie bisher, ohne Prüfung des Autors.
 * Begründung: neue Zeilen tragen den Einlieferer immer, eine Fälschung ist
 * damit nur noch in Zeilen möglich, die schon vor der Umstellung lagen, und
 * die räumt der 120-Tage-Sweeper bis spätestens Februar 2027 ab. Sie zu
 * verwerfen kostete dagegen jedem Frischgerät ohne Sicherung den ganzen
 * Archiv-Verlauf bis zur Umstellung. Eine Bestandszeile kann trotzdem nichts
 * an einem liegenden Satz ändern als seine Kennung
 * (`verlauf/satz.ts::satzErgaenzen`), und eine Grabstein-Zeile gibt es nur
 * mit Einlieferer. Produktentscheidung, offen gemeldet am 2026-10-12.
 */
const BESTANDSZEILEN_ANNEHMEN = true;

/**
 * Klartext einer Zeile plus ihr Einlieferer (Server, `user_id`) → Eintrag,
 * oder `null`: die Zeile wird verworfen. Verworfen wird eine Zeile, deren
 * Autor nicht ihr Einlieferer ist, und jede Grabstein-Zeile ohne bekannten
 * Einlieferer. Wirft bei kaputtem JSON (wie `leseZeilenKlar`).
 */
export function leseZeile(
	kanalId: string,
	roh: string,
	einlieferer: string | null
): ArchivEintrag | null {
	const inhalt = JSON.parse(roh) as Partial<ArchivZeileKlar & GrabsteinZeileKlar>;
	const vomAutor = einlieferer !== null && inhalt.a === einlieferer;
	if (inhalt.g !== undefined) {
		return vomAutor && istGueltigeKennung(inhalt.g)
			? { art: 'grabstein', autorId: einlieferer, kennung: inhalt.g }
			: null;
	}
	const angenommeneBestandszeile = einlieferer === null && BESTANDSZEILEN_ANNEHMEN;
	if (!vomAutor && !angenommeneBestandszeile) return null;
	if (!istGueltigeKennung(inhalt.i) || !istGueltigeKennung(inhalt.a)) return null;
	return { art: 'nachricht', nachricht: zuNachricht(kanalId, ohneUngueltigeBezuege(inhalt)) };
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
