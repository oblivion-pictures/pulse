/**
 * Die Quelle der Kanal-Festigung: der LOKALE VERLAUF des Besitzer-Geräts,
 * nicht das Postfach. Löst `postfachQuelle.ts` ab (bis 2026-10-17).
 *
 * **Der Fehler, gegen den diese Datei steht.** Die Postfach-Quelle las nur
 * den noch nicht quittierten Bestand. Der normale Empfangsweg quittiert aber
 * jede Zustellung, sobald sie lokal liegt (`krypto/empfangen.ts`, Schritt 4),
 * und das binnen Millisekunden nach dem Weckruf `postfach_neu` — die
 * Festigung, die alle 30 s nachsah, fand den Kanal deshalb so gut wie immer
 * leer. Das Laufwerk erhielt nur, was zufällig im Fenster zwischen Abholen
 * und Quittieren lag. Nachgewiesen in `tests/e2e/e2e-ablage-kanal.spec.ts`
 * („landet im Laufwerk des Besitzers"): vor dem Wechsel rot, Laufwerk leer.
 *
 * **Warum der Verlauf und nicht „Quittung zurückhalten".** Der Verlauf ist
 * per Vertrag vollständig: quittiert wird erst, was dort sicher liegt
 * (`empfangen.ts`, „die wichtigste Reihenfolge des ganzen Vorhabens"). Die
 * Quittung zurückzuhalten, bis das Laufwerk geschrieben ist, hätte dagegen
 * das Postfach des Besitzer-Geräts gefüllt, solange das Laufwerk nicht
 * erreichbar ist — und der Server nimmt je Gerät nur 50 offene Zustellungen
 * je Absender und 500 insgesamt an (`config.py::postfach_max_offene_*`),
 * danach überspringt er das Gerät. Ein totes Laufwerk hätte dem Besitzer
 * die Nachrichten selbst genommen; nach 30 Tagen räumt die Frist ohnehin.
 *
 * **Die Rahmen-Id bleibt, was sie war:** die Nachrichten-Id des Satzes, und
 * die IST für Empfangenes die Zustellungs-Id dieses Geräts
 * (`krypto/empfangeneNachricht.ts`, „Snowflake der Zustellung"). Genau unter
 * dieser Id schrieb die Postfach-Quelle — ein bestehendes Laufwerk setzt mit
 * seinem Wasserzeichen fort, Format und Leser bleiben unberührt (zu dem, was
 * darunter fehlt, s. „Löcher" unten).
 *
 * **Nur der Snowflake-Bereich.** Nachrichten, die DIESES Gerät selbst
 * geschrieben hat, liegen unter einer lokalen Id (19 Stellen,
 * `krypto/lokaleNachrichtId.ts`), und die liegt numerisch über JEDER
 * Snowflake (`verlauf/zeitSeite.ts`, Kopf). Eine einzige davon im Log, und
 * das Wasserzeichen stünde über allem, was danach empfangen wird — der
 * Schreiber verlangt streng aufsteigende Ids. Sie bleiben deshalb draussen,
 * wie bisher: ein Absender beliefert sein eigenes Gerät nicht
 * (`gruppengeraete.ts::gruppengeraeteBerechnen`), die Postfach-Quelle sah
 * sie nie. (Was andere Geräte desselben Kontos schreiben, kommt über das
 * Postfach und wird gefestigt.) Diese Lücke ist bekannt und offen; sie zu
 * schliessen braucht eine eigene Rahmen-Ordnung, keine andere Quelle.
 *
 * **Anhalten statt überspringen — die Haltegrenze aus dem Postfach.** Eine
 * Gruppennachricht, deren Schlüssel noch fehlt, bleibt unquittiert im
 * Postfach liegen und wird später geöffnet (`gruppe/empfangen.ts`,
 * „repariert sich selbst") — dann unter ihrer ALTEN, kleineren Zustellungs-
 * Id. Wäre das Wasserzeichen inzwischen an ihr vorbei, käme sie nie mehr ins
 * Log. Die Festigung geht deshalb nie über die kleinste noch offene
 * Zustellung dieses Kanals hinaus (`haltegrenze`), dieselbe Zusage, die die
 * Postfach-Quelle mit ihrem Abbruch an der ersten unlesbaren Zustellung gab.
 * Gelesen wird der Bestand nur — `abholen` löscht nichts, quittiert wird hier
 * nichts, geöffnet auch nicht: diese Quelle fasst keine Megolm-Sitzung mehr
 * an und braucht deshalb die Konto-Sperre nicht, die die Postfach-Quelle um
 * ihr Öffnen legen musste.
 *
 * **Reihenfolge der beiden Lesevorgänge: erst das Postfach, dann der
 * Verlauf — und nur, was zum Postfach-Blick schon reif war.** Andersherum
 * könnte eine Zustellung zwischen beiden Blicken quittiert werden und in
 * keinem auftauchen. Aber auch so bleibt ein Fenster (Gegenprüfung
 * 2026-10-17): kommen NACH dem Postfach-Blick zwei Zustellungen an, eine
 * unlesbare (101) und eine lesbare (102), und legt der Empfangsweg 102 ab,
 * bevor der Verlauf gelesen wird, stünde 102 im Log und 101 fiele später
 * unter das Wasserzeichen. Dazu kommt der Rest, den schon die Postfach-Quelle
 * hatte: eine Id ist vergeben, ihre Zeile aber erst nach dem Blick
 * festgeschrieben.
 *
 * Beides schliesst die **Reifezeit**: gefestigt wird nur, was nach seiner
 * Snowflake-Zeit mindestens `REIFEZEIT_MS` vor dem Postfach-Blick entstand.
 * Eine so alte Zustellung war beim Blick längst festgeschrieben — stand sie
 * nicht im Postfach, war sie quittiert und damit im Verlauf; stand sie
 * drin, ist sie die Haltegrenze. Die Zeit kommt vom Aufrufer, produktiv als
 * Schätzung der SERVER-Uhr (`watch/clockSync.ts`, kalibriert am
 * `ready`-Rahmen; unkalibriert die eigene Uhr): Snowflakes tragen die
 * Server-Uhr, und eine vorgehende Klienten-Uhr schmälerte sonst die Frist um
 * genau ihren Vorsprung. Die Minute deckt Commit-Dauer und Schätzfehler weit
 * ab; der Preis ist, dass eine Nachricht frühestens eine Minute nach dem
 * Empfang im Laufwerk steht.
 *
 * **Was nicht ins Laufwerk geht:** Grabsteine (gelöscht ist gelöscht, auch
 * vor dem Festigen), Ungeprüftes (`verlauf/herkunft.ts`, dieselbe Regel wie
 * für die eigene Sicherung) und Unverschlüsseltes. Ein Ablage-Kanal kennt
 * keinen Klartext-Weg; unverschlüsselt liegt hier etwa, was der Sicherungs-
 * Nachschub aus der Kette eines ANDEREN Geräts zurückholt
 * (`sicherung/nutzlast.ts::zuWire` setzt `verschluesselt` nicht) — die
 * Kopie eines fremden Geräts, die als Doppel ins Log käme. Dieser Ausschluss
 * hängt also an `zuWire`: wer dort `verschluesselt` nachträgt, muss solche
 * Sätze hier anders erkennen.
 *
 * Die Auswahl steht in `festigbar` und muss im LESER wirken, nicht erst hier:
 * filterte nur diese Quelle, liefe eine Seite voller Grabsteine leer, das
 * Wasserzeichen rückte nie vor, und jede Runde läse dieselbe Seite.
 *
 * **Bekannte Doppel-Lücke:** die Kopplung legt die Sätze des alten Geräts
 * unter dessen Zustellungs-Ids ab und erhält `verschluesselt`
 * (`verlauf/herkunft.ts::ausUmzug`). Kam eine Nachricht zwischen Anmeldung
 * des neuen Geräts und der Übernahme an, liegt sie dort zweimal — und ist
 * das neue Gerät das Besitzer-Gerät, gehen beide ins Log. Die Anzeige legt
 * sie über die Kennung zusammen (`verlauf/zusammenfuegen.ts`); das Log
 * bleibt doppelt. Selten (das Laufwerk muss danach auf dem NEUEN Gerät
 * verbunden werden, `fuerKanal` reist nicht mit), und eine Herkunftsmarke
 * am Nachschub wäre die Abhilfe.
 *
 * **Löcher aus der Zeit vor dem Wechsel bleiben.** Ein Laufwerk, das schon
 * ein Wasserzeichen trägt, hat darunter die Nachrichten verloren, die die
 * Postfach-Quelle nie sah; ein append-only-Log mit aufsteigenden Ids nimmt
 * sie nicht mehr auf. Ein leeres Laufwerk dagegen holt den ganzen Verlauf
 * nach.
 *
 * **Entschlüsselt ablegen** (Typ `TYP_KLARTEXT_JSON`), Begründung aus der
 * Postfach-Quelle übernommen: das Archiv soll Jahre überleben, eine
 * Megolm-Sitzung rotiert bei jedem Mitgliederwechsel — ein Geheimtext wäre
 * ohne genau die rotierten Sitzungen wertlos (`format.ts`, `TYP_MEGOLM`).
 *
 * Importfrei bis auf `.ts`-Pfade (Nodes Testläufer); Postfach und Verlauf
 * kommen als Parameter (`verlaufQuelleVerdrahtung.ts`).
 */

import { TYP_KLARTEXT_JSON } from './format.ts';
import { ausSatz, kodiereNachricht, type SatzAusschnitt } from './nutzlast.ts';
import type { NachzieherQuelle } from './nachzieher.ts';
import type { AblageEintrag } from './schreiber.ts';
import type { PostfachZustellung } from '../api/postfach.ts';
import { ART_GRUPPENNACHRICHT } from '../krypto/gruppe/gruppenNutzlast.ts';
import { istUngeprueft } from '../verlauf/herkunft.ts';
import { SNOWFLAKE_EPOCH_MS, SNOWFLAKE_ZEIT_SHIFT } from '../utils/snowflakeZeit.ts';

/** Die erste Id jenseits des Snowflake-Bereichs: ab hier beginnen die
 *  lokalen Ids (19 Stellen). Dieselbe Grenze wie `verlauf/zeitSeite.ts::
 *  BEREICHE` — und dieselbe Frist: im Juli 2033 erreichen Snowflakes selbst
 *  19 Stellen. */
export const SNOWFLAKE_BEREICH_ENDE = 10n ** 18n;

/** Wie alt eine Zustellung beim Postfach-Blick mindestens sein muss, damit
 *  sie gefestigt wird — s. Modulkopf, „Reifezeit". */
export const REIFEZEIT_MS = 60_000;

/** Die kleinste Snowflake, die zur Millisekunde `ms` (Server-Uhr) oder
 *  später entstand. */
function ersteSnowflakeAb(ms: number): bigint {
	const seitEpoche = BigInt(Math.floor(ms)) - SNOWFLAKE_EPOCH_MS;
	return seitEpoche <= 0n ? 0n : seitEpoche << SNOWFLAKE_ZEIT_SHIFT;
}

/** Der Ausschnitt eines Verlaufs-Satzes, den die Festigung braucht. */
export interface FestigungsSatz extends SatzAusschnitt {
	geloescht: boolean;
	verschluesselt: boolean;
	ungeprueft?: true;
}

/** Ob ein Satz ins Laufwerk gehört — s. Modulkopf, „Was nicht ins Laufwerk
 *  geht". Der Leser wendet das an, bevor er zählt. */
export function festigbar(satz: FestigungsSatz): boolean {
	return !satz.geloescht && satz.verschluesselt && !istUngeprueft(satz);
}

/** Die Id, vor der die Festigung anhält (ausschliesslich): die kleinste noch
 *  offene Gruppen-Zustellung dieses Kanals, höchstens das Ende des
 *  Snowflake-Bereichs. */
export function haltegrenze(kanalId: string, offen: readonly PostfachZustellung[]): bigint {
	let grenze = SNOWFLAKE_BEREICH_ENDE;
	for (const z of offen) {
		if (z.channel_id !== kanalId || z.art !== ART_GRUPPENNACHRICHT) continue;
		const id = BigInt(z.id);
		if (id < grenze) grenze = id;
	}
	return grenze;
}

/** Der offene Postfach-Bestand dieses Geräts (nur lesen). */
type OffenerBestand = () => Promise<PostfachZustellung[]>;

/** Liest bis zu `limit` festigbare Sätze des Kanals mit `nach < id < bis`,
 *  aufsteigend (`nach === null`: vom Anfang). */
type SaetzeLesen = (
	nach: bigint | null,
	bis: bigint,
	limit: number,
) => Promise<FestigungsSatz[]>;

/**
 * @param jetztMs Die Server-Uhr in Millisekunden, so gut bekannt (s.
 *   Modulkopf, „Reifezeit").
 */
export function verlaufQuelle(
	kanalId: string,
	offenerBestand: OffenerBestand,
	saetzeLesen: SaetzeLesen,
	jetztMs: () => number,
): NachzieherQuelle {
	return {
		async holen(nachId, limit) {
			// Erst die Uhr, dann das Postfach, dann der Verlauf — s. Modulkopf.
			const reif = ersteSnowflakeAb(jetztMs() - REIFEZEIT_MS);
			const halt = haltegrenze(kanalId, await offenerBestand());
			const bis = halt < reif ? halt : reif;
			if (nachId !== null && nachId + 1n >= bis) return [];
			const saetze = await saetzeLesen(nachId, bis, limit);

			// Der Leser sagt zu, aufsteigend, im Fenster und gefiltert zu
			// liefern. Hier trotzdem sortiert und geprüft (dieselbe Vorsicht wie
			// `quelle.ts`): ein Verstoss liesse den Schreiber werfen, eine
			// unsortierte Seite liesse kleinere Ids unter das Wasserzeichen
			// fallen, und eine lokale Id höbe es über alles Spätere (s.
			// Modulkopf, „Nur der Snowflake-Bereich").
			const imFenster = saetze
				.filter((satz) => /^[1-9][0-9]*$/.test(satz.nachrichtId) && festigbar(satz))
				.map((satz) => ({ satz, id: BigInt(satz.nachrichtId) }))
				.filter(({ id }) => (nachId === null || id > nachId) && id < bis)
				.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			const eintraege: AblageEintrag[] = [];
			for (const { satz, id } of imFenster) {
				if (eintraege.length >= limit) break;
				if (eintraege.length > 0 && eintraege[eintraege.length - 1].id === id) continue;
				eintraege.push({ id, typ: TYP_KLARTEXT_JSON, nutzlast: kodiereNachricht(ausSatz(satz)) });
			}
			return eintraege;
		},
	};
}
