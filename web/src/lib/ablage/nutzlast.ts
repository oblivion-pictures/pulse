/**
 * Das Nutzlast-Schema des Ablage-Logs: was eine Nachricht im Bestand IST,
 * getrennt von der Form, in der sie über die Leitung kommt. Phase 1 schreibt
 * Klartext-JSON (Rahmen-Typ 1); der Krypto-Nachzug behält dieselbe Feldstruktur
 * bei und steckt sie in Megolm-Nutzlasten — wer heute das Schema liest, liest
 * später den entschlüsselten Inhalt.
 *
 * Bewusst NICHT im Schema: die vorsignierten Abruf-Adressen der Anhänge
 * (kurzlebig, gehören nie in einen dauerhaften Bestand) und Reaktionen
 * (veränderlich — das Log ist append-only).
 *
 * Rein rechnerisch und import-frei bis auf den Typ-Import (wird zur
 * Laufzeit weggeblasen) und die selbst importfreie Kennungs-Regel
 * (`.ts`-Pfad) — Node-Testläufer-regel.
 */

import type { Message } from '../api/types.ts';
import { istGueltigeKennung, kanonischeId } from '../verlauf/identitaet.ts';

export const NUTZLAST_FASSUNG = 1;

interface AblageAnhang {
	id: string;
	name: string | null;
	mime: string | null;
	groesse: number;
}

export interface AblageNachricht {
	fassung: number;
	id: string;
	autor: string;
	inhalt: string;
	/** Zeitpunkt des Sendens, wie der Server ihn nennt (ISO). */
	zeit: string;
	/** Zeitpunkt der letzten Bearbeitung, sonst null. */
	bearbeitet: string | null;
	antwortAuf: string | null;
	anhaenge: AblageAnhang[];
	/** Grabstein: nur bei einem Lösch-Frame `true` (absent = nicht gelöscht).
	 *  Der Stein trägt die Id, seit 2026-10-11 auch Autor und Kennung (s.
	 *  `grabstein`); der Inhalt bleibt leer. Ältere Container kennen das Feld
	 *  nicht; der Parser liest es tolerant. */
	geloescht?: boolean;
	/** Die geraeteuebergreifende Autor-ID (`Message.krypto_id`). Jedes Gerät
	 *  legt dieselbe logische Nachricht unter seiner EIGENEN lokalen Id ab
	 *  (Autor-Id bzw. Zustellungs-Id) — ohne dieses Merkmal erkennt der
	 *  Wiederherstellungs-Leser die Kopie des anderen Geräts nicht und die
	 *  Nachricht erscheint doppelt. Tolerant gelesen wie `geloescht`; Bestände
	 *  vor der Erweiterung tragen das Feld nicht (Fassung bleibt 1), die
	 *  Kopie des Autors trägt es erst seit 2026-10-13 — Leser vergleichen
	 *  deshalb über `verlauf/nachrichtIdentitaet.ts`. */
	kryptoId?: string;
}

export class NutzlastFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'NutzlastFehler';
	}
}

/** Ein Anhang in der Bestand-Form: VERBATIM übernommen (statt auf vier
 *  Felder verkürzt) — bei verschlüsselten Nachrichten trägt er den
 *  Dateischlüssel, ohne den kein wiederhergestelltes Gerät den Anhang je
 *  wieder öffnen könnte —, nur ohne die kurzlebigen Abruf-Adressen. Fehlende
 *  Namen, MIME-Typen und Größen werden aufgefüllt statt durchgereicht: ohne
 *  Größe wiese `leseNachricht` den ganzen Rahmen ab, und mit ihm die
 *  Nachricht; ein fehlender Name oder MIME-Typ käme dort als Zeichenkette
 *  „undefined" zurück. */
function zuAblageAnhang(anhang: Record<string, unknown>): AblageAnhang {
	const { url: _url, thumb_url: _thumb, ...dauerhaft } = anhang;
	return {
		...dauerhaft,
		id: String(anhang.id),
		name: (anhang.filename as string | null | undefined) ?? null,
		mime: (anhang.mime as string | null | undefined) ?? null,
		groesse: Number(anhang.size ?? 0),
	};
}

/** Übersetzt eine Nachricht vom Wire in die Bestand-Form. */
export function ausWire(m: Message): AblageNachricht {
	return {
		fassung: NUTZLAST_FASSUNG,
		id: m.id,
		autor: m.author_id,
		inhalt: m.content,
		zeit: m.created_at,
		bearbeitet: m.edited_at ?? null,
		antwortAuf: m.reply_to_id ?? null,
		anhaenge: (m.attachments ?? []).map(zuAblageAnhang),
		...(m.krypto_id ? { kryptoId: m.krypto_id } : {}),
	};
}

/** Der Ausschnitt eines Verlaufs-Satzes (`verlauf/schema.ts::Satz`), den
 *  `ausSatz` liest — strukturell beschrieben, ohne Import. */
export interface SatzAusschnitt {
	nachrichtId: string;
	autorId: string;
	inhalt: string;
	erstelltAm: string;
	bearbeitetAm: string | null;
	antwortAufId?: string | null;
	anhaenge?: unknown[];
	kryptoId?: string | null;
}

/**
 * Übersetzt einen abgelegten Satz des lokalen Verlaufs in die Bestand-Form —
 * der Weg der Erstsicherung (`sicherung/andock.ts::sicherungErstsicherung`).
 *
 * Bis 2026-10-11 baute die Erstsicherung die Bestand-Form von Hand nach und
 * ließ dabei die `kryptoId` weg — als `ausWire` sie bekam (2ca26243), wurde
 * diese zweite Stelle nicht mitgezogen. Ein Empfangs-Satz (Zustellungs-ID D,
 * Kennung K) wanderte so als Nachricht ohne Kennung in die Sicherung, und
 * nach dem nächsten Gerätewechsel stand er neben seiner Kopie doppelt. Beide
 * Wege teilen sich deshalb jetzt die Anhang-Umwandlung, und die Kennung
 * steht in beiden genau einmal. Dass beide für dieselbe Nachricht dieselbe
 * Bestand-Form liefern, hält `test/sicherung-umwandlung.test.ts` fest.
 */
export function ausSatz(satz: SatzAusschnitt): AblageNachricht {
	return {
		fassung: NUTZLAST_FASSUNG,
		id: satz.nachrichtId,
		autor: satz.autorId,
		inhalt: satz.inhalt,
		zeit: satz.erstelltAm,
		bearbeitet: satz.bearbeitetAm,
		antwortAuf: satz.antwortAufId ?? null,
		anhaenge: (Array.isArray(satz.anhaenge) ? satz.anhaenge : [])
			.filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
			.map(zuAblageAnhang),
		...(satz.kryptoId ? { kryptoId: satz.kryptoId } : {}),
	};
}

/**
 * Ein Grabstein-Rahmen (`sicherung/andock.ts::sicherungGrabstein`): die
 * lokale ID der gelöschten Nachricht, kein Inhalt. Seit 2026-10-11 reisen
 * Autor und Kennung des gelöschten Satzes mit, wo er lokal noch lag — ohne
 * sie traf der Stein auf die Zustellungs-ID D die Archiv-Kopie desselben
 * Worts (lokale ID K) nie, und die gelöschte Nachricht stand nach der
 * Wiederherstellung wieder da. Kein Formatbruch: `autor` ist ohnehin ein
 * Pflichtfeld (bisher leer), `kryptoId` ein tolerant gelesenes Zusatzfeld.
 * Ein älterer Stein trägt beides nicht; was er beim Wiederherstellen trifft,
 * steht in `sicherung/eintragsGruppen.ts` (die Gruppe seiner lokalen ID).
 *
 * **Ältere Klienten lesen einen Stein mit Kennung unsauber** (Gegenprüfung
 * 2026-10-12, Fund 8) — nicht behebbar, nur festgehalten. Ihr Leser
 * (`wiederherstellen.ts` vor dieser Reihe) legte Rahmen nur über
 * `kryptoId`↔`kryptoId` zusammen und ließ den Stein unter SEINER ID neben
 * der Kopie stehen: liest er die Kopie zuerst, bleibt sie nach dem
 * Wiederherstellen sichtbar; liest er den Stein zuerst, verschwindet sie.
 * Ein alter Tab liest so bis zum nächsten Neuladen. Das Grabstein-Register
 * (`verlauf/grabsteinRegister.ts`) kennen solche Tabs auch nicht — ihre
 * Schreibwege prüfen es nicht; `verlauf/dbRegister.ts::gebundenLoeschenInTx`
 * fängt die Kopie unter der Kennung beim nächsten Anwenden wieder ein.
 *
 * Die Kennung ist die kanonische (`verlauf/identitaet.ts::kanonischeId`):
 * die `kryptoId` eines Empfangs-Satzes, sonst seine eigene ID — beim
 * Verfasser IST die ID die Kennung, und erst mit ihr trifft der Stein auch
 * die Empfangs-Kopien derselben Nachricht auf den anderen eigenen Geräten.
 */
export function grabstein(
	id: string,
	satz?: { autorId: string; kryptoId?: string | null },
): AblageNachricht {
	return {
		fassung: NUTZLAST_FASSUNG,
		id,
		autor: satz?.autorId ?? '',
		inhalt: '',
		zeit: new Date().toISOString(),
		bearbeitet: null,
		antwortAuf: null,
		anhaenge: [],
		geloescht: true,
		...(satz !== undefined ? { kryptoId: kanonischeId(id, satz.kryptoId) } : {}),
	};
}

/** Festes Feldfolge — gleiche Nachricht ergibt immer gleiche Bytes. */
export function kodiereNachricht(n: AblageNachricht): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			fassung: n.fassung,
			id: n.id,
			autor: n.autor,
			inhalt: n.inhalt,
			zeit: n.zeit,
			bearbeitet: n.bearbeitet,
			antwortAuf: n.antwortAuf,
			anhaenge: n.anhaenge,
			// Nur der Grabstein trägt das Feld — normaler Bestand bleibt
			// byte-identisch zum Feldstand vor der Grabstein-Erweiterung.
			geloescht: n.geloescht ? true : undefined,
			// Dasselbe Spiel: absent bleibt absent, das JSON alter Bestände
			// wird um kein Byte verändert.
			kryptoId: n.kryptoId || undefined,
		}),
	);
}

/**
 * Strenger Parse: jede Abweichung vom Schema ist ein Befund.
 *
 * **Die ID muss eine Kennung sein** (`verlauf/identitaet.ts::istGueltigeKennung`,
 * Gegenprüfung 2026-10-12, Fund 1). Ein Stein mit der frei gewählten ID `"x"`
 * stand seit e27257b0 in der Sicherung, und der Wiederherstellungs-Leser warf
 * beim Sortieren (`BigInt`) — der Kanal ließ sich nie mehr wiederherstellen.
 * Ein solcher Rahmen ist jetzt ein Befund wie jede andere Abweichung: die
 * Leser überspringen ihn (`sicherung/wiederherstellen.ts`,
 * `ablage/kanalLeseweg.ts`). Was nur ein Bezug ist, verliert dagegen bloß
 * sich selbst: eine ungültige `kryptoId` fällt weg, ein ungültiger
 * Antwortbezug wird `null`, ein Anhang ohne gültige ID fällt aus der Liste —
 * die Nachricht selbst bleibt lesbar.
 */
export function leseNachricht(bytes: Uint8Array): AblageNachricht {
	const roh = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
	if (roh.fassung !== NUTZLAST_FASSUNG) {
		throw new NutzlastFehler(`Unbekannte Nutzlast-Fassung: ${String(roh.fassung)}`);
	}
	for (const feld of ['id', 'autor', 'inhalt', 'zeit'] as const) {
		if (typeof roh[feld] !== 'string') {
			throw new NutzlastFehler(`${feld} fehlt oder ist kein String`);
		}
	}
	if (!istGueltigeKennung(roh.id)) {
		throw new NutzlastFehler('id ist keine Kennung');
	}
	if (roh.bearbeitet !== null && typeof roh.bearbeitet !== 'string') {
		throw new NutzlastFehler('bearbeitet ist weder String noch null');
	}
	if (roh.antwortAuf !== null && typeof roh.antwortAuf !== 'string') {
		throw new NutzlastFehler('antwortAuf ist weder String noch null');
	}
	if (!Array.isArray(roh.anhaenge)) {
		throw new NutzlastFehler('anhaenge ist keine Liste');
	}
	// Tolerant: Feld einfach fehlt in jedem Bestand vor der Grabstein-
	// Erweiterung — nur ein FALSCHER Typ ist ein Befund.
	if (roh.geloescht !== undefined && typeof roh.geloescht !== 'boolean') {
		throw new NutzlastFehler('geloescht ist kein Boolean');
	}
	if (roh.kryptoId !== undefined && typeof roh.kryptoId !== 'string') {
		throw new NutzlastFehler('kryptoId ist kein String');
	}
	const anhaenge = roh.anhaenge
		.map((a) => {
			const anhang = a as Record<string, unknown>;
			if (typeof anhang.id !== 'string' || typeof anhang.groesse !== 'number') {
				throw new NutzlastFehler('Anhang ohne id oder groesse');
			}
			// Verbatim: Fremdfelder (z. B. der Dateischlüssel verschlüsselter
			// Anhänge) bleiben erhalten — das Wiederherstellen braucht sie.
			return {
				...anhang,
				id: anhang.id,
				name: anhang.name === null ? null : String(anhang.name),
				mime: anhang.mime === null ? null : String(anhang.mime),
				groesse: anhang.groesse,
			};
		})
		.filter((anhang) => istGueltigeKennung(anhang.id));
	return {
		fassung: NUTZLAST_FASSUNG,
		id: roh.id,
		autor: roh.autor as string,
		inhalt: roh.inhalt as string,
		zeit: roh.zeit as string,
		bearbeitet: roh.bearbeitet as string | null,
		antwortAuf: istGueltigeKennung(roh.antwortAuf) ? roh.antwortAuf : null,
		anhaenge,
		// Absent bleibt absent (weder `false` noch ein undefined-Schlüssel) —
		// der Rundlauf einer normalen Nachricht ergibt wieder dasselbe Objekt.
		...(roh.geloescht === true ? { geloescht: true } : {}),
		...(istGueltigeKennung(roh.kryptoId) ? { kryptoId: roh.kryptoId } : {}),
	};
}
