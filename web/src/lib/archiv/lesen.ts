/**
 * Leseweg des Server-Archivs (Übergabe 2026-10-04, §5): holt verschlüsselte
 * Zeilen beim chat-gateway, öffnet den Kanal-Schlüssel mit dem eigenen
 * Konto-Schlüssel und schreibt die Nachrichten in den LOKALEN Verlauf —
 * derselbe Weg, den die Sicherungs-Spiegelung nimmt (`sicherung/andock`).
 * Ein Gerät ohne lokalen Bestand (Neuinstallation, zweiter Rechner) bekommt
 * so „überall den exakten Verlauf“.
 *
 * Der Lesestand je Kanal ist ein Cursor, der von NEU nach ALT wandert: der
 * Kanalwechsel-Öffner lädt die jüngsten Seiten, jedes Hochscrollen eine
 * weitere ältere — bis eine Seite leer kommt (dann ist das Archiv für
 * diesen Kanal ausgelesen). Neue Nachrichten landen am jungen Ende und
 * berühren den Cursor nicht.
 *
 * Bestandsaufnahme: das Archiv trägt nur, was seit der Einrichtung GESENDET
 * wurde — kein Backfill alter Verläufe. Anhänge reisen als Angaben mit, die
 * Bytes nicht: das lesende Gerät zeigt die Kachel und holt sie aus der
 * eigenen Sicherung, wenn es welche hat (§5.4, `zeile.ts`).
 *
 * Jede Zeile läuft durch `zeile.ts::leseZeile`: eine Zeile, deren Autor nicht
 * ihr Einlieferer ist, fällt heraus, und eine Grabstein-Zeile des Autors
 * löscht seine Nachricht — gebunden an ihn, wie ein Lösch-Frame
 * (`krypto/loeschZiel.ts`).
 */

import { auth } from '$lib/stores/auth.svelte';
import { archivKanalSchluessel, archivSeite } from '$lib/api/archiv';
import { kanalSchluesselHolen } from './kanalSchluessel';
import { entschluesseleZeile } from './krypto';
import { leseZeile, type ArchivNachricht, type Grabstein } from './zeile';
import { archivPaar } from './konto';
import { verlaufErgaenzen, verlaufGebundenGeloescht } from '$lib/verlauf';
import { messages } from '$lib/stores/messages.svelte';

const SEITEN_GROESSE = 500;

function vonB64(wert: string): Uint8Array {
	const binär = atob(wert);
	const bytes = new Uint8Array(binär.length);
	for (let i = 0; i < binär.length; i++) bytes[i] = binär.charCodeAt(i);
	return bytes;
}

/** Lesestand je Kanal: ältester schon geholter Zeilen-Id (`null` = Anfang). */
const lesestand = new Map<string, string>();

/**
 * Zieht die nächste(n) Archiv-Seite(n) in den lokalen Verlauf. `maxSeiten`
 * steuert, wie viel auf einmal nachkommt (Öffner: mehrere, Scrollen: eine).
 * Rückgabe: Anzahl neu abgelegter Sätze. Wirft nie — Aufrufer sind
 * fire-and-forget (Kanalwechsel, Hochscrollen).
 */
export async function archivNachziehen(kanalId: string, maxSeiten = 4): Promise<number> {
	try {
		const kontoId = auth.user?.id;
		if (!kontoId) return 0;
		const paar = await archivPaar(kontoId);
		if (!paar) return 0; // Archiv auf diesem Gerät zu — kein lokaler Schaden

		const eigenWrap = await archivKanalSchluessel(kanalId);
		if (!eigenWrap) return 0; // noch nie archiviert
		// Ziele leer: hier läuft die Erstanlage nie (oben wird ohne eigenen
		// Wrap schon ausgestiegen) — es geht nur ums Öffnen des eigenen.
		const { schluessel: kanalSchluessel } = await kanalSchluesselHolen(kanalId, paar, []);

		let gesamt = 0;
		for (let seite = 0; seite < maxSeiten; seite++) {
			const vorId = lesestand.get(kanalId);
			const zeilen = await archivSeite(kanalId, vorId, SEITEN_GROESSE);
			if (zeilen.length === 0) break;
			const nachrichten: ArchivNachricht[] = [];
			const grabsteine: Grabstein[] = [];
			let verworfen = 0;
			for (const zeile of zeilen) {
				try {
					const klarText = new TextDecoder().decode(
						await entschluesseleZeile(kanalSchluessel, vonB64(zeile.nutzlast_b64))
					);
					const eintrag = leseZeile(zeile.channel_id, klarText, zeile.user_id ?? null);
					if (eintrag === null) verworfen++;
					else if (eintrag.art === 'grabstein') grabsteine.push(eintrag);
					else nachrichten.push(eintrag.nachricht);
				} catch (e) {
					// Eine unlesbare Zeile (kaputter Wrap, fremde Fassung) blockiert
					// nicht die übrigen — der Rest des Archivs bleibt verwertbar.
					console.info('[archiv] lesen: Zeile unlesbar', (e as Error).message);
				}
			}
			if (verworfen > 0) {
				console.info('[archiv] lesen: Zeilen verworfen, Autor ist nicht der Einlieferer', verworfen);
			}
			if (nachrichten.length > 0) {
				// Ergänzen, nicht überschreiben: die Zeile kennt keine Löschung,
				// Bearbeitung oder Reaktion — der lokale Satz schon.
				gesamt += await verlaufErgaenzen(kanalId, nachrichten);
			}
			// Grabsteine NACH den Nachrichten der Seite: sie treffen auch, was
			// diese Seite gerade abgelegt hat.
			for (const stein of grabsteine) await grabsteinAnwenden(kanalId, stein);
			// Server liefert aufsteigend — die ERSTE Id ist die älteste der Seite.
			lesestand.set(kanalId, zeilen[0].id);
			if (zeilen.length < SEITEN_GROESSE) break;
		}
		return gesamt;
	} catch (e) {
		console.warn('[archiv] Nachziehen fehlgeschlagen', e);
		return 0;
	}
}

/** Eine Grabstein-Zeile: jeden lokalen Satz DIESES Autors mit dieser Kennung
 *  löschen (`loeschZiel.ts::trifftFrame`), im Verlauf und in der Anzeige,
 *  und die Löschung ins Grabstein-Register eintragen — eine ältere Seite mit
 *  der Nachricht selbst kommt erst NACH dieser (gelesen wird neu nach alt)
 *  und landet dann als Grabstein. */
async function grabsteinAnwenden(kanalId: string, stein: Grabstein): Promise<void> {
	for (const id of await verlaufGebundenGeloescht(kanalId, stein.kennung, stein.autorId)) {
		messages.remove(kanalId, id);
	}
}
