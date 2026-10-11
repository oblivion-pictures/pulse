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
 * beim Verfasser und im Archiv liegt). Ältere Steine tragen keinen Autor
 * (`autor: ''`) und treffen nur ihre eigene lokale ID.
 *
 * Importfrei bis auf erweiterungspflichtige Relativpfade (Node-Testläufer).
 */

import type { SicherungEintrag } from './nutzlast.ts';
import { kanonischeId, nachrichtIdentitaet } from '../verlauf/identitaet.ts';

interface Gruppe {
	eintrag: SicherungEintrag;
	/** Alle lokalen IDs der zusammengelegten Rahmen. */
	lokaleIds: Set<string>;
	/** Autor aus den Nachrichten-Rahmen — leer, solange nur ein Stein ohne
	 *  Autor die Gruppe kennt. */
	autor: string;
	/** Kanonische Kennung, sobald ein Nachrichten-Rahmen sie verraten hat. */
	kanonisch: string | null;
}

/** Die Kennung K eines Steins, der seinen Autor nennt (seit 2026-10-11,
 *  `ablage/nutzlast.ts::grabstein`), sonst `null`: die Kennung allein wählt
 *  der Absender frei, erst zusammen mit dem Autor zählt sie. */
function steinKennung(eintrag: SicherungEintrag): string | null {
	const { autor, kryptoId } = eintrag.nachricht;
	return autor !== '' && kryptoId ? kryptoId : null;
}

/** Die lokalen IDs, die ein Grabstein-Rahmen trifft: seine eigene, und —
 *  nennt er seinen Autor — auch die Kennung K als LOKALE ID: unter K liegt
 *  die Nachricht beim Verfasser und im Archiv. Ein Stein ohne Autor nennt
 *  nur sich selbst. */
function steinZiele(eintrag: SicherungEintrag): string[] {
	const { id } = eintrag.nachricht;
	const kennung = steinKennung(eintrag);
	return kennung !== null && kennung !== id ? [id, kennung] : [id];
}

function istStein(eintrag: SicherungEintrag): boolean {
	return eintrag.nachricht.geloescht === true;
}

/** Mehr Anhänge = reichere Fassung (dieselbe Regel wie vorher im Leser). */
function reicher(neu: SicherungEintrag, alt: SicherungEintrag): boolean {
	return neu.nachricht.anhaenge.length > alt.nachricht.anhaenge.length;
}

/** Neueste zuerst (Nachricht-Snowflake), bei gleicher ID nach Kanal. */
function neuesteZuerst(a: SicherungEintrag, b: SicherungEintrag): number {
	if (a.nachricht.id === b.nachricht.id) return a.kanalId.localeCompare(b.kanalId);
	return BigInt(a.nachricht.id) > BigInt(b.nachricht.id) ? -1 : 1;
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

	/** Anzahl logischer Nachrichten — die Seitengrenze des Lesers. */
	get groesse(): number {
		return this.gruppen.size;
	}

	private wurzel(schluessel: string | undefined): string | undefined {
		let s = schluessel;
		while (s !== undefined && this.weiter.has(s)) s = this.weiter.get(s);
		return s;
	}

	private gruppeUeberLokaleId(kanalId: string, id: string): string | undefined {
		return this.wurzel(this.jeLokalerId.get(`${kanalId}:${id}`));
	}

	/** Legt Gruppe `b` in Gruppe `a` (beide Wurzeln). Ein Stein gewinnt, sonst
	 *  die reichere Fassung. */
	private vereinigen(a: string, b: string): void {
		if (a === b) return;
		const ga = this.gruppen.get(a)!;
		const gb = this.gruppen.get(b)!;
		if (!istStein(ga.eintrag) && (istStein(gb.eintrag) || reicher(gb.eintrag, ga.eintrag))) {
			ga.eintrag = gb.eintrag;
		}
		for (const id of gb.lokaleIds) ga.lokaleIds.add(id);
		ga.autor ||= gb.autor;
		ga.kanonisch ??= gb.kanonisch;
		this.gruppen.delete(b);
		this.weiter.set(b, a);
	}

	private neueGruppe(eintrag: SicherungEintrag, lokaleIds: string[], autor: string): string {
		const schluessel = String(this.naechsterSchluessel++);
		this.gruppen.set(schluessel, {
			eintrag,
			lokaleIds: new Set(lokaleIds),
			autor,
			kanonisch: null,
		});
		return schluessel;
	}

	private lokaleIdMerken(kanalId: string, id: string, schluessel: string): void {
		const lokal = `${kanalId}:${id}`;
		if (!this.jeLokalerId.has(lokal)) this.jeLokalerId.set(lokal, schluessel);
	}

	aufnehmen(eintrag: SicherungEintrag): void {
		if (istStein(eintrag)) this.steinAufnehmen(eintrag);
		else this.nachrichtAufnehmen(eintrag);
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
		const ziel = ueberId ?? ueberIdentitaet ?? this.neueGruppe(eintrag, [n.id], n.autor);
		// Kennen lokale ID und Identität verschiedene Gruppen, werden sie eine.
		if (ueberIdentitaet !== undefined) this.vereinigen(ziel, ueberIdentitaet);
		const gruppe = this.gruppen.get(ziel)!;
		// Die reichere Fassung ersetzt die liegende UNTER DEREN Schlüssel —
		// sonst stünden beide da. Ein Stein bleibt Stein. (Eine frische Gruppe
		// trägt Rahmen, ID und Autor schon.)
		if (!istStein(gruppe.eintrag) && reicher(eintrag, gruppe.eintrag)) {
			gruppe.eintrag = eintrag;
		}
		gruppe.lokaleIds.add(n.id);
		gruppe.autor ||= n.autor;
		gruppe.kanonisch ??= kanonischeId(n.id, n.kryptoId);
		this.lokaleIdMerken(kanalId, n.id, ziel);
		if (!this.jeIdentitaet.has(identitaet)) this.jeIdentitaet.set(identitaet, ziel);
	}

	private steinAufnehmen(stein: SicherungEintrag): void {
		const { kanalId, nachricht: n } = stein;
		const ziele = steinZiele(stein);
		const getroffen = new Set<string>();
		for (const id of ziele) {
			const schluessel = this.gruppeUeberLokaleId(kanalId, id);
			if (schluessel === undefined) continue;
			const autor = this.gruppen.get(schluessel)!.autor;
			// Ein Stein MIT Autor trifft nur Gruppen dieses Autors.
			if (n.autor !== '' && autor !== '' && autor !== n.autor) continue;
			getroffen.add(schluessel);
		}
		// Alle getroffenen Gruppen werden eine; `getroffen` hält Wurzeln, und
		// das Vereinigen in die erste lässt die übrigen Wurzeln. Trifft der
		// Stein keine, bekommt er eine eigene.
		const [erste, ...rest] = [...getroffen];
		const ziel = erste ?? this.neueGruppe(stein, ziele, n.autor);
		for (const andere of rest) this.vereinigen(ziel, andere);
		const gruppe = this.gruppen.get(ziel)!;
		if (!istStein(gruppe.eintrag)) gruppe.eintrag = stein;
		gruppe.autor ||= n.autor;
		// Die Kennung eines Steins mit Autor gilt wie die eines Rahmens.
		gruppe.kanonisch ??= steinKennung(stein);
		for (const id of ziele) {
			gruppe.lokaleIds.add(id);
			this.lokaleIdMerken(kanalId, id, ziel);
		}
	}

	/** Je Gruppe ein Eintrag; eine gelöschte Gruppe als ein Stein JE lokaler
	 *  ID, mit dem Autor und der Kennung der Gruppe, soweit bekannt. Neueste
	 *  zuerst (Nachricht-Snowflake) — dieselbe Ordnung, die die Ansicht nach
	 *  dem Merge erwartet. */
	ergebnis(): SicherungEintrag[] {
		const aus: SicherungEintrag[] = [];
		for (const gruppe of this.gruppen.values()) {
			if (!istStein(gruppe.eintrag)) {
				aus.push(gruppe.eintrag);
				continue;
			}
			const { kryptoId: _ohne, ...stein } = gruppe.eintrag.nachricht;
			const kennung = gruppe.kanonisch !== null ? { kryptoId: gruppe.kanonisch } : {};
			for (const id of gruppe.lokaleIds) {
				aus.push({
					...gruppe.eintrag,
					nachricht: { ...stein, id, autor: gruppe.autor, ...kennung },
				});
			}
		}
		return aus.sort(neuesteZuerst);
	}
}
