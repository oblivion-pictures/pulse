/**
 * Der Sicherungs-Eintrag: was eine Zeile im Sicherungs-Log IST — die
 * verschlüsselte Nutzlast eines Rahmens vom Typ 3 (ablage/format.ts).
 *
 * Zwei Felder, die das Kanal-Ablage-Nutzlast-Schema (ablage/nutzlast.ts)
 * nicht trägt: die **kanalId** — der Sicherungs-Container fasst ALLE
 * verschlüsselten Gespräche des Kontos in EINEN Bestand, deshalb reist der
 * Kanal je Eintrag mit — und die Fassung des Umschlags selbst.
 *
 * Bewusst DRAUSSEN am Rahmen: die Eintrags-Id im Rahmenkopf ist der
 * gerätelokale Folgezähler des Spiegels (spiegel.ts), NICHT die Snowflake
 * der Nachricht — zwei Geräte zählen unabhängig, und die echte Ordnung
 * kommt beim Wiederherstellen aus den Nachricht-Ids der Nutzlasten.
 *
 * Rein rechnerisch, Node-Testläufer-regel.
 */

import { leseNachricht, NUTZLAST_FASSUNG, type AblageNachricht } from '../ablage/nutzlast.ts';
import type { Satz } from '../verlauf/schema.ts';

const SICHERUNG_EINTRAG_FASSUNG = 1;

export interface SicherungEintrag {
	fassung: number;
	kanalId: string;
	nachricht: AblageNachricht;
}

/** Übersetzt eine Nachricht vom Wire in einen Sicherungs-Eintrag. */
export function sicherungEintrag(kanalId: string, nachricht: AblageNachricht): SicherungEintrag {
	return { fassung: SICHERUNG_EINTRAG_FASSUNG, kanalId, nachricht };
}

/**
 * Ein lokaler Verlaufs-Satz → Sicherungs-Nachricht (Erstsicherung: der
 * Bestand wird NACHGEHOLT, ohne dass die Nachricht je neu über den Wire kam).
 *
 * **`kryptoId` muss mit.** Es ist das einzige Merkmal, an dem der
 * Wiederherstellungs-Leser und der Anzeige-Merge (`verlauf/zusammenfuegen.ts`)
 * die Kopie eines anderen Geräts als dieselbe Nachricht erkennen. Die erste
 * Fassung dieser Umwandlung (inline in `andock.ts`) ließ es weg: lag auf dem
 * Frischgerät schon eine Zeile aus dem Server-Archiv (`krypto_id` = eigene
 * Id), schrieb die Erstsicherung sie ohne Merkmal in die Sicherung, die
 * Wiederherstellung legte sie damit OHNE Merkmal wieder ab — und dieselbe
 * Nachricht stand doppelt im Kanal (Archiv-Kopie + Zustellungs-Kopie).
 */
export function satzZuAblageNachricht(satz: Satz): AblageNachricht {
	return {
		fassung: NUTZLAST_FASSUNG,
		id: satz.nachrichtId,
		autor: satz.autorId,
		inhalt: satz.inhalt,
		zeit: satz.erstelltAm,
		bearbeitet: satz.bearbeitetAm,
		antwortAuf: satz.antwortAufId ?? null,
		// Anhang-Metadaten aus dem lokalen Satz — die BYTES holt
		// `sicherungAnhaenge` aus dem gerätelokalen Bytes-Speicher und
		// legt sie als eigene Dateien ins Archiv. Was das Gerät nicht
		// mehr hält, bleibt außen vor (ehrliche Grenze).
		anhaenge: Array.isArray(satz.anhaenge)
			? (satz.anhaenge as Array<Record<string, unknown>>).map((a) => ({
					...a,
					id: String(a.id),
					name: (a.filename as string | null) ?? null,
					mime: (a.mime as string | null) ?? null,
					groesse: Number(a.size ?? 0),
				}))
			: [],
		...(satz.kryptoId ? { kryptoId: satz.kryptoId } : {}),
	};
}

/** Festes Feldfolge — gleicher Eintrag ergibt immer gleiche Bytes. */
export function kodiereSicherungEintrag(eintrag: SicherungEintrag): Uint8Array {
	const n = eintrag.nachricht;
	return new TextEncoder().encode(
		JSON.stringify({
			fassung: eintrag.fassung,
			kanalId: eintrag.kanalId,
			nachricht: {
				fassung: n.fassung,
				id: n.id,
				autor: n.autor,
				inhalt: n.inhalt,
				zeit: n.zeit,
				bearbeitet: n.bearbeitet,
				antwortAuf: n.antwortAuf,
				anhaenge: n.anhaenge,
				// Grabstein-Markierung reist mit — ohne sie wäre der Stein nach
				// dem Entschlüsseln von einer normalen Nachricht ununterscheidbar.
				geloescht: n.geloescht ? true : undefined,
				// Die geraeteuebergreifende Autor-ID ebenso — ohne sie erkennt
				// der Wiederherstellungs-Leser die Kopie des anderen Geräts
				// nicht (doppelte Zeile auf dem Frischgerät).
				kryptoId: n.kryptoId || undefined,
			},
		}),
	);
}

/** Strenger Parse: jede Abweichung vom Schema ist ein Befund. */
export function leseSicherungEintrag(bytes: Uint8Array): SicherungEintrag {
	const roh = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
	if (roh.fassung !== SICHERUNG_EINTRAG_FASSUNG) {
		throw new Error(`Unbekannte Sicherungs-Eintrag-Fassung: ${String(roh.fassung)}`);
	}
	if (typeof roh.kanalId !== 'string' || roh.kanalId.length === 0) {
		throw new Error('kanalId fehlt oder ist kein String');
	}
	return {
		fassung: SICHERUNG_EINTRAG_FASSUNG,
		kanalId: roh.kanalId,
		nachricht: leseNachricht(new TextEncoder().encode(JSON.stringify(roh.nachricht))),
	};
}
