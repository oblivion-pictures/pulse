/**
 * Legt die Einträge EINES Lesedurchgangs des Sicherungs-Ordners zu logischen
 * Nachrichten zusammen — die Duplikat-Rechnung von
 * `wiederherstellen.ts::leseSicherungKanalSeite`.
 *
 * Dieselbe Nachricht kommt aus mehreren Geräte-Ketten: jedes Gerät spiegelt
 * sie unter SEINER lokalen ID (Verfasser: eigene ID, Empfänger:
 * Zustellungs-ID, Erstsicherung: die ID des Satzes, aus dem sie entstand).
 * Zusammengelegt wird deshalb nach zwei Wegen, und beide führen in dieselbe
 * Gruppe:
 *
 *   - **gleiche lokale ID** im selben Kanal (zwei Rahmen desselben Satzes,
 *     etwa nach einer Bearbeitung oder vom Absturz-Puffer doppelt gespült);
 *   - **gleiche Identität** (`verlauf/identitaet.ts`: Autor + kanonische
 *     Kennung) — die Kopie des anderen Geräts.
 *
 * Bis 2026-10-11 lief der zweite Weg nur über `kryptoId`↔`kryptoId`; die
 * Verfasser-Kopie (ohne `kryptoId`) blieb eine eigene Zeile. Und eine
 * reichere Fassung wurde unter IHRER ID abgelegt statt unter der der
 * Gruppe — beide Fassungen standen dann nebeneinander.
 *
 * **Grabsteine laufen NICHT über die Identität.** Ein Grabstein-Rahmen trifft
 * die Gruppe, der eine seiner lokalen Ziel-IDs angehört (`steinZiele`), und
 * jede Gruppe merkt sich ALLE lokalen IDs ihrer Rahmen. So trifft der Stein
 * auf die Zustellungs-ID D auch dann, wenn die Kopie des Verfassers (ID K)
 * zuerst gelesen wurde — vorher entstand dann ein Stein für D neben einer
 * sichtbaren K. Eine getroffene Gruppe bleibt gelöscht, egal welche Fassung
 * später noch kommt, und die Ausgabe nennt für jede ihrer lokalen IDs einen
 * Stein: auf dem wiederherstellenden Gerät kann jede davon liegen.
 *
 * Trägt der Stein einen Autor, trifft er nur Gruppen DIESES Autors, und zu
 * seinen Ziel-IDs gehört dann auch die Kennung K (unter der die Nachricht
 * beim Verfasser und im Archiv liegt).
 *
 * **Ein Stein ohne Autor (`autor: ''`, vor 2026-10-11) gehört zu keiner
 * Gruppe.** Er wirkt nur auf seine eigene lokale ID: die Ausgabe nennt ihn
 * unverändert (ohne Autor, ohne Kennung), und für die Gruppe, in der diese
 * ID liegt, gilt der beste Rahmen UNTER EINER ANDEREN lokalen ID weiter
 * (Eigentümer-Entscheid 2026-10-13, „nie über Kennung“). Bis 2026-10-14
 * traf er die ganze Gruppe seiner ID samt den IDs, die über die Identität
 * dazugekommen waren, und kam für jede als Stein MIT dem Autor und der
 * Kennung der Gruppe heraus — `andockLesen.ts::steinAnwenden` machte daraus
 * eine gebundene Löschung. Zu diesen Steinen gehören die des N1-Rückfalls,
 * also Löschungen, die ein Gesprächspartner mit der Kennung einer fremden
 * Nachricht ausgelöst hatte (Gegenprüfung 2026-10-14, V1).
 *
 * Importfrei bis auf erweiterungspflichtige Relativpfade (Node-Testläufer).
 */

import type { SicherungEintrag } from './nutzlast.ts';
import { kanonischeId, nachrichtIdentitaet } from '../verlauf/identitaet.ts';
import { vergleicheSnowflakeArtigeId } from '../utils/snowflakeZeit.ts';

interface Gruppe {
	/** Die Nachrichten-Rahmen, in der Reihenfolge des Lesens. */
	rahmen: SicherungEintrag[];
	/** Der erste Stein MIT Autor, der die Gruppe getroffen hat. */
	stein: SicherungEintrag | null;
	/** Alle lokalen IDs der zusammengelegten Rahmen und Steine. */
	lokaleIds: Set<string>;
	/** Autor aus den Rahmen bzw. dem Stein. */
	autor: string;
	/** Kanonische Kennung, sobald ein Rahmen sie verraten hat. */
	kanonisch: string | null;
	/** Ob `kanonisch` eine echte Kennung ist (eine `kryptoId`, die von der
	 *  lokalen ID abweicht) und nicht der Rückfall auf die eigene ID. */
	kennungEcht: boolean;
}

/** Übernimmt eine Kennung in die Gruppe — eine echte geht vor dem Rückfall
 *  auf die lokale ID, egal in welcher Reihenfolge die Rahmen kommen
 *  (Gegenprüfung 2026-10-12, Fund 6). Bis dahin setzte der ERSTE Rahmen
 *  die Kennung: kam ein Rahmen ohne `kryptoId` (Zustellungs-ID D, aus der
 *  Zeit vor 2ca26243) vor dem mit `kryptoId` K, trugen die Steine der
 *  Gruppe D als Kennung und trafen die Kopie unter K nie. */
function kennungUebernehmen(gruppe: Gruppe, kennung: string | null, echt: boolean): void {
	if (kennung === null) return;
	if (echt && !gruppe.kennungEcht) {
		gruppe.kanonisch = kennung;
		gruppe.kennungEcht = true;
	} else {
		gruppe.kanonisch ??= kennung;
	}
}

/** Die lokalen IDs, die ein Stein MIT Autor trifft: seine eigene und seine
 *  Kennung K als LOKALE ID — unter K liegt die Nachricht beim Verfasser und
 *  im Archiv. Die Kennung allein wählt der Absender frei, erst zusammen mit
 *  dem Autor zählt sie (seit 2026-10-11, `ablage/nutzlast.ts::grabstein`). */
function steinZiele(eintrag: SicherungEintrag): string[] {
	const { id, kryptoId } = eintrag.nachricht;
	return kryptoId && kryptoId !== id ? [id, kryptoId] : [id];
}

function istStein(eintrag: SicherungEintrag): boolean {
	return eintrag.nachricht.geloescht === true;
}

/** Der Rahmen, den die Gruppe zeigt: der erste mit den meisten Anhängen
 *  (mehr Anhänge = reichere Fassung). `auslassen` hält die lokalen IDs, die
 *  ein Stein ohne Autor getroffen hat. `null`, wenn kein Rahmen bleibt. */
function besterRahmen(
	rahmen: readonly SicherungEintrag[],
	auslassen: ReadonlyMap<string, unknown>,
): SicherungEintrag | null {
	let bester: SicherungEintrag | null = null;
	for (const eintrag of rahmen) {
		if (auslassen.has(`${eintrag.kanalId}:${eintrag.nachricht.id}`)) continue;
		if (bester === null || eintrag.nachricht.anhaenge.length > bester.nachricht.anhaenge.length) {
			bester = eintrag;
		}
	}
	return bester;
}

/** Neueste zuerst (Nachricht-Snowflake), bei gleicher ID nach Kanal. Mit
 *  `vergleicheSnowflakeArtigeId` statt `BigInt`: der Vergleich wirft auf
 *  keiner ID, auch nicht auf einer frei gewählten aus dem Altbestand — mit
 *  `BigInt("x")` riss bis 2026-10-12 jede Wiederherstellung des Kanals ab
 *  (Gegenprüfung 2026-10-12, Fund 1). Er ordnet außerdem nach der Zeit wie die
 *  Anzeige, statt eine lokale ID (19 Stellen) stets hinter jede Snowflake
 *  (18 Stellen) zu stellen. */
function neuesteZuerst(a: SicherungEintrag, b: SicherungEintrag): number {
	if (a.nachricht.id === b.nachricht.id) return a.kanalId.localeCompare(b.kanalId);
	return vergleicheSnowflakeArtigeId(b.nachricht.id, a.nachricht.id);
}

export class EintragsGruppen {
	/** Gruppen-Schlüssel → Gruppe. Der Schlüssel ist ein laufender Zähler,
	 *  nicht `kanal:id`: zwei Rahmen derselben ID, die die Autor-Prüfung
	 *  getrennt hält, brauchen zwei Gruppen, und unter einem gemeinsamen
	 *  Schlüssel überschriebe die zweite die erste. */
	private readonly gruppen = new Map<string, Gruppe>();
	private naechsterSchluessel = 0;
	/** Weiterleitung nach einer Vereinigung: alter Schlüssel → neuer. */
	private readonly weiter = new Map<string, string>();
	private readonly jeLokalerId = new Map<string, string>();
	private readonly jeIdentitaet = new Map<string, string>();
	/** Steine ohne Autor, je `kanal:id` — außerhalb jeder Gruppe (Modulkopf). */
	private readonly ohneAutor = new Map<string, SicherungEintrag>();

	/** Anzahl logischer Nachrichten — die Seitengrenze des Lesers. */
	get groesse(): number {
		return this.gruppen.size + this.ohneAutor.size;
	}

	private wurzel(schluessel: string | undefined): string | undefined {
		let s = schluessel;
		while (s !== undefined && this.weiter.has(s)) s = this.weiter.get(s);
		return s;
	}

	private gruppeUeberLokaleId(kanalId: string, id: string): string | undefined {
		return this.wurzel(this.jeLokalerId.get(`${kanalId}:${id}`));
	}

	/** Legt Gruppe `b` in Gruppe `a` (beide Wurzeln). */
	private vereinigen(a: string, b: string): void {
		if (a === b) return;
		const ga = this.gruppen.get(a)!;
		const gb = this.gruppen.get(b)!;
		ga.rahmen.push(...gb.rahmen);
		ga.stein ??= gb.stein;
		for (const id of gb.lokaleIds) ga.lokaleIds.add(id);
		ga.autor ||= gb.autor;
		kennungUebernehmen(ga, gb.kanonisch, gb.kennungEcht);
		this.gruppen.delete(b);
		this.weiter.set(b, a);
	}

	private neueGruppe(autor: string): string {
		const schluessel = String(this.naechsterSchluessel++);
		this.gruppen.set(schluessel, {
			rahmen: [],
			stein: null,
			lokaleIds: new Set(),
			autor,
			kanonisch: null,
			kennungEcht: false,
		});
		return schluessel;
	}

	private lokaleIdMerken(kanalId: string, id: string, schluessel: string): void {
		const lokal = `${kanalId}:${id}`;
		if (!this.jeLokalerId.has(lokal)) this.jeLokalerId.set(lokal, schluessel);
	}

	aufnehmen(eintrag: SicherungEintrag): void {
		if (!istStein(eintrag)) this.nachrichtAufnehmen(eintrag);
		else if (eintrag.nachricht.autor === '') this.ohneAutorMerken(eintrag);
		else this.steinAufnehmen(eintrag);
	}

	private ohneAutorMerken(stein: SicherungEintrag): void {
		const lokal = `${stein.kanalId}:${stein.nachricht.id}`;
		if (!this.ohneAutor.has(lokal)) this.ohneAutor.set(lokal, stein);
	}

	private nachrichtAufnehmen(eintrag: SicherungEintrag): void {
		const { kanalId, nachricht: n } = eintrag;
		const identitaet = `${kanalId}|${nachrichtIdentitaet(n.autor, n.id, n.kryptoId)}`;
		// Gleiche lokale ID nur bei passendem Autor — ein fremder Autor unter
		// derselben ID ist kein Duplikat, sondern ein Widerspruch, und der
		// wird nicht zusammengelegt.
		let ueberId = this.gruppeUeberLokaleId(kanalId, n.id);
		if (ueberId !== undefined) {
			const autor = this.gruppen.get(ueberId)!.autor;
			if (autor !== '' && autor !== n.autor) ueberId = undefined;
		}
		const ueberIdentitaet = this.wurzel(this.jeIdentitaet.get(identitaet));
		const ziel = ueberId ?? ueberIdentitaet ?? this.neueGruppe(n.autor);
		// Kennen lokale ID und Identität verschiedene Gruppen, werden sie eine.
		if (ueberIdentitaet !== undefined) this.vereinigen(ziel, ueberIdentitaet);
		const gruppe = this.gruppen.get(ziel)!;
		gruppe.rahmen.push(eintrag);
		gruppe.lokaleIds.add(n.id);
		gruppe.autor ||= n.autor;
		const kennung = kanonischeId(n.id, n.kryptoId);
		kennungUebernehmen(gruppe, kennung, kennung !== n.id);
		this.lokaleIdMerken(kanalId, n.id, ziel);
		if (!this.jeIdentitaet.has(identitaet)) this.jeIdentitaet.set(identitaet, ziel);
	}

	/** Ein Stein MIT Autor: trifft die Gruppen seiner Ziel-IDs, soweit sie
	 *  diesem Autor gehören, und legt sie zusammen. */
	private steinAufnehmen(stein: SicherungEintrag): void {
		const { kanalId, nachricht: n } = stein;
		const ziele = steinZiele(stein);
		const getroffen = new Set<string>();
		for (const id of ziele) {
			const schluessel = this.gruppeUeberLokaleId(kanalId, id);
			if (schluessel === undefined) continue;
			const autor = this.gruppen.get(schluessel)!.autor;
			if (autor !== '' && autor !== n.autor) continue;
			getroffen.add(schluessel);
		}
		// Alle getroffenen Gruppen werden eine; `getroffen` hält Wurzeln, und
		// das Vereinigen in die erste lässt die übrigen Wurzeln. Trifft der
		// Stein keine, bekommt er eine eigene.
		const [erste, ...rest] = [...getroffen];
		const ziel = erste ?? this.neueGruppe(n.autor);
		for (const andere of rest) this.vereinigen(ziel, andere);
		const gruppe = this.gruppen.get(ziel)!;
		gruppe.stein ??= stein;
		gruppe.autor ||= n.autor;
		// Die Kennung eines Steins gilt wie die eines Rahmens.
		const kennung = n.kryptoId ?? null;
		kennungUebernehmen(gruppe, kennung, kennung !== null && kennung !== n.id);
		for (const id of ziele) {
			gruppe.lokaleIds.add(id);
			this.lokaleIdMerken(kanalId, id, ziel);
		}
	}

	/** Je Gruppe ein Eintrag; eine von einem Stein mit Autor getroffene Gruppe
	 *  als ein Stein JE lokaler ID, mit dem Autor und der Kennung der Gruppe.
	 *  Dazu jeder Stein ohne Autor, wie er gelesen wurde. Neueste zuerst
	 *  (Nachricht-Snowflake) — dieselbe Ordnung, die die Ansicht nach dem
	 *  Merge erwartet. */
	ergebnis(): SicherungEintrag[] {
		const aus: SicherungEintrag[] = [...this.ohneAutor.values()];
		for (const gruppe of this.gruppen.values()) {
			if (gruppe.stein === null) {
				const rahmen = besterRahmen(gruppe.rahmen, this.ohneAutor);
				if (rahmen !== null) aus.push(rahmen);
				continue;
			}
			const { kryptoId: _ohne, ...stein } = gruppe.stein.nachricht;
			const kennung = gruppe.kanonisch !== null ? { kryptoId: gruppe.kanonisch } : {};
			for (const id of gruppe.lokaleIds) {
				aus.push({
					...gruppe.stein,
					nachricht: { ...stein, id, autor: gruppe.autor, ...kennung },
				});
			}
		}
		return aus.sort(neuesteZuerst);
	}
}
