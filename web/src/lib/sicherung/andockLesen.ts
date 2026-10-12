/**
 * Die Lesewege der Andock-Schicht: eine Seite (Chat-Ansicht) oder den ganzen
 * Bestand (Knopf der Sicherungsektion) aus dem Archiv-Ordner in den lokalen
 * Verlauf legen. Aus `andock.ts` herausgelöst (2026-10-11), weil jene Datei
 * über die Größengrenze gewachsen war; die Lesewege brauchen keinen
 * Spiegel-Zustand, `andock.ts` reicht die beiden Einstiege unverändert durch.
 *
 * Läuft nie im Node-Läufer (hängt an IndexedDB, s. `andock.ts`-Modulkopf).
 */

import type { AblageAdapter } from '../ablage/adapter.ts';
import type { AblageNachricht } from '../ablage/nutzlast.ts';
import {
	verlaufSaetzeErgaenzen,
	verlaufMarkiereGeloescht,
	verlaufGebundenLoeschen,
} from '../verlauf/db.ts';
import { aktuellesKonto } from '../verlauf/konto.ts';
import { sortierSchluessel, zuSatz } from '../verlauf/satz.ts';
import { KANAL_ORDNER_MUSTER, leseSicherungKanalSeite } from './wiederherstellen.ts';
import { zuWire, type SicherungEintrag } from './nutzlast.ts';
import { ordnerAdapter } from './spiegel.ts';
import { adapterLieferant } from './ziele.ts';
import { dekAusZwischenlager, lesestandLesen, lesestandSchreiben } from './geraete.ts';

/** Wandelt gelesene Sicherungs-Einträge in Verlaufs-Sätze — die geteilte
 *  Rechnung von seitenweisem und Bulk-Laden (Umwandlung: `nutzlast.ts::
 *  zuWire`). Anhang-BYTES bleiben draußen: die holt die Chat-Ansicht lazily
 *  aus dem Archiv, wenn eine Kachel gerendert wird (krypto/anhangHolen.ts →
 *  archivAnhang), sonst läde der erste Login alles. */
function eintraegeZuSaetze(eintraege: SicherungEintrag[], kontoId: string) {
	return eintraege
		.map((eintrag) => zuSatz(eintrag.kanalId, zuWire(eintrag.nachricht), kontoId))
		.filter((satz) => satz !== null);
}

/**
 * Lädt EINE Seite aus dem Archiv-Ordner des Kanals in den lokalen Verlauf —
 * der seitenweise Weg der Chat-Ansicht (Kanal öffnen, Hochscrollen). Der
 * Lesestand wird je Konto+Kanal geführt (geraete.ts); der nächste Aufruf
 * liefert nur noch strikt ältere Nachrichten.
 *
 * **Wirft nie** und liefert 0, wenn die Sicherung nicht bereit ist — der
 * Aufrufer feuert und vergisst, ein totes Ziel darf die Ansicht nie
 * blockieren (Regel 1 im Modulkopf).
 */
export async function sicherungKanalSeiteLaden(kanalId: string, anzahl = 50): Promise<number> {
	try {
		const entpackt = await dekAusZwischenlager();
		if (entpackt === null) return 0;
		const kontoId = aktuellesKonto();
		if (kontoId === null) return 0;
		const adapter = await adapterLieferant();
		return (await kanalSeiteFüttern(adapter, entpackt.dek, kontoId, kanalId, anzahl)).anzahl;
	} catch {
		return 0;
	}
}

/** Eine Seite (oder mit `anzahl = Infinity` den ganzen Ordner) lesen und in
 *  den lokalen Verlauf legen — die geteilte Rechnung beider Lade-Wege. Der
 *  Rückgabewert reicht die Erschöpfungs-Kennung des Lesers mit durch (B10):
 *  `erschoepft` heißt, der Lauf hat die `anzahl`-Grenze nie erreicht, der
 *  Ordner trägt dahinter nichtsmehr. */
async function kanalSeiteFüttern(
	adapter: AblageAdapter,
	dek: Uint8Array,
	kontoId: string,
	kanalId: string,
	anzahl: number,
): Promise<{ anzahl: number; erschoepft: boolean }> {
	const altStand = await lesestandLesen(kontoId, kanalId);
	const { eintraege, lesestand, erschoepft } = await leseSicherungKanalSeite(
		ordnerAdapter(adapter, kanalId),
		dek,
		altStand,
		anzahl,
	);
	if (eintraege.length === 0) return { anzahl: 0, erschoepft };
	const sichtbar = eintraege.filter((e) => e.nachricht.geloescht !== true);
	const saetze = eintraegeZuSaetze(sichtbar, kontoId);
	// Ergänzen, nicht überschreiben (`satz.ts::satzErgaenzen`): ein hier
	// schon liegender Satz desselben Kontos behält Grabstein, Bearbeitung,
	// Reaktionen und seine kryptoId — die Sicherung ist eine Kopie von früher.
	// Sie darf mehr ergänzen als das Archiv (Anhänge, Antwortbezug): sie
	// stammt aus eigenen Sätzen, beschreiben kann sie nur dieses Konto.
	if (saetze.length > 0) await verlaufSaetzeErgaenzen(saetze, kontoId, 'sicherung');
	// Grabsteine NACH den sichtbaren Sätzen: was diese Seite gerade abgelegt
	// hat, kann ein Stein mit Autor und Kennung noch treffen. Sie werden
	// NICHT als Satz angelegt. Ein Stein mit Autor trägt seine Löschung ins
	// Grabstein-Register ein (`verlauf/grabsteinRegister.ts`): kommt die
	// Nachricht erst auf einer SPÄTEREN Seite (gelesen wird neu nach alt, zwei
	// Geräte-Ketten können beide Reihenfolgen liefern) oder legt das
	// Server-Archiv eine Kopie erst nach diesem Lauf ab, landet sie trotzdem
	// als Grabstein. Bis 2026-10-12 stand sie dann wieder sichtbar da.
	for (const eintrag of eintraege) {
		if (eintrag.nachricht.geloescht === true) {
			await steinAnwenden(kanalId, eintrag.nachricht, kontoId);
		}
	}
	// Lesestand erst NACH erfolgreichem Ablegen anheben — ein Fehler mid-run
	// lässt den nächsten Lauf dieselbe Seite noch einmal lesen (Ergänzen
	// über die Nachrichten-Ids ist wiederholbar).
	await lesestandSchreiben(kontoId, kanalId, lesestand);
	return { anzahl: saetze.length, erschoepft };
}

/**
 * Wendet einen gelesenen Grabstein auf den lokalen Verlauf an. Nennt er
 * seinen Autor (`ablage/nutzlast.ts::grabstein`), ist das eine gebundene
 * Löschung (`verlauf/dbLoeschen.ts::verlaufGebundenLoeschen`): seine lokale
 * ID und seine Kennung gehen ins Grabstein-Register, und jeder lokale Satz
 * DIESES Autors, den ein Lösch-Frame mit einer der beiden träfe
 * (`krypto/loeschZiel.ts::trifftFrame`), wird Grabstein — die Archiv-Kopie
 * unter K ebenso wie eine Empfangs-Kopie unter einer anderen Zustellungs-ID
 * (Befund N3). Gebunden an den Autor: die Kennung allein wählt der Absender
 * frei. Ein älterer Stein ohne Autor trifft hier nur den Satz unter seiner
 * lokalen ID und trägt nichts ins Register ein — er löst nie eine Identität
 * auf. Bis hierher hat ihn der Leser (`eintragsGruppen.ts`) aber schon auf
 * die Gruppe seiner ID ausgeweitet und, wo die Sicherung den Autor kennt,
 * mit ihm versehen; ohne Autor kommt nur an, was dort keinem Rahmen
 * zuzuordnen war.
 */
export async function steinAnwenden(
	kanalId: string,
	stein: AblageNachricht,
	kontoId: string,
): Promise<void> {
	if (stein.autor === '') {
		await verlaufMarkiereGeloescht(sortierSchluessel(kanalId, stein.id), kontoId);
		return;
	}
	const kennungen = stein.kryptoId ? [stein.id, stein.kryptoId] : [stein.id];
	await verlaufGebundenLoeschen(kanalId, kontoId, stein.autor, kennungen);
}

/**
 * Holt den GESAMTEN Archiv-Bestand in den lokalen Verlauf (Bulk-Weg, Knopf
 * der Sicherungsektion). Läuft je Kanal-Ordner mit demselben Lesestand wie
 * der seitenweise Weg — beide Wege teilen sich den Fortschritt. Anhang-BYTES
 * lädt sie bewusst NICHT (s. `eintraegeZuSaetze`).
 */
export async function sicherungArchivLaden(): Promise<number> {
	const entpackt = await dekAusZwischenlager();
	if (entpackt === null) return 0;
	const kontoId = aktuellesKonto();
	if (kontoId === null) return 0;
	const adapter = await adapterLieferant();
	// EIN Lauf je Kanal-Ordner — ein Ordner existiert, sobald er ein
	// Segment trägt (KANAL_ORDNER_MUSTER über die Wurzel-Listung).
	const kanalIds = new Set<string>();
	for (const name of await adapter.liste()) {
		const treffer = KANAL_ORDNER_MUSTER.exec(name);
		if (treffer !== null) kanalIds.add(treffer[1]!);
	}
	let gesamt = 0;
	for (const kanalId of kanalIds) {
		// B10: der Leser meldet die Erschöpfung selbst (`erschoepft`) — der
		// frühere zweite Lauf (lieferte 0) lud je Kanal-Ordner ALLE Dateien
		// erneut aus dem Drive, nur um sie zu bestätigen. Mit `Infinity`
		// trifft die `anzahl`-Grenze nie zu, ein Lauf ist also stets
		// erschöpft: genau ein Lauf je Ordner, die Schleife bricht sofort.
		for (;;) {
			const seite = await kanalSeiteFüttern(adapter, entpackt.dek, kontoId, kanalId, Infinity);
			gesamt += seite.anzahl;
			if (seite.erschoepft) break;
		}
	}
	return gesamt;
}
