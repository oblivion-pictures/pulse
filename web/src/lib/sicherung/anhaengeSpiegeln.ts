/**
 * Das Spiegeln der Anhang-BYTES — aus `andock.ts` herausgelöst (2026-10-12),
 * als jene Datei mit dem Grabstein-Register über die harte Größengrenze
 * gewachsen wäre. Braucht keinen Spiegel-Zustand, nur Ziel und Schlüssel.
 * Inhalt unverändert.
 *
 * Läuft nie im Node-Läufer (hängt an IndexedDB, s. `andock.ts`-Modulkopf).
 */

import type { AblageNachricht } from '../ablage/nutzlast.ts';
import { anhangBytesLesen } from '../verlauf/db.ts';
import { aktuellesKonto } from '../verlauf/konto.ts';
import { verschlüsseleEintrag } from './krypto.ts';
import { adapterLieferant } from './ziele.ts';
import { anhangDateiName, dekAusZwischenlager } from './geraete.ts';

/**
 * Spiegelt die LOKAL vorhandenen Anhang-Bytes der Nachrichten in das
 * Archiv (verschlüsselt mit dem DEK). Die Bytes muss dieses Gerät haben —
 * empfangende Geräte holen sie vor dem Spiegeln, sendende behalten sie im
 * Empfangsfall ihrer Gegenseite. Fehlen sie hier, überspringt der Lauf
 * den Anhang still: die Gegenseite hat dieselben Bytes und spiegelt sie.
 */
export async function sicherungAnhaenge(kanalId: string, nachrichten: AblageNachricht[]): Promise<void> {
	const dek = (await dekAusZwischenlager())?.dek;
	if (dek === undefined) return;
	const adapter = await adapterLieferant();
	for (const nachricht of nachrichten) {
			// Autorenschafts-Regel (2026-09-02): spiegelt wird nur, was DIESES
			// Konto selbst gesendet hat — der Absender ist der natürliche
			// Allein-Schreiber eines Anhangs. Empfängergeräte überspringen;
			// ohne die Regel schrieben beide Geräte desselben Kontos denselben
			// Klumpen und trieben Doppel-Dateien ins Drive.
			if (nachricht.autor !== aktuellesKonto()) continue;
		for (const anhang of nachricht.anhaenge) {
			try {
				// Dedup: Bei mehreren Geräten desselben Kontos hat JEDES die
				// Bytes im Cache — ohne diese Prüfung überschriebe jedes sie
				// mit identischem Inhalt (verschwendeter Upload, kein Verlust).
				if ((await adapter.lese(anhangDateiName(anhang.id))) !== null) continue;
				const lokal = await anhangBytesLesen(anhang.id);
				if (!lokal) continue;
				const klar = new Uint8Array(await lokal.daten.arrayBuffer());
				await adapter.schreibe(anhangDateiName(anhang.id), await verschlüsseleEintrag(dek, klar));
			} catch {
				/* Anhang überspringen — die Nachricht selbst ist längst gesichert */
			}
		}
	}
}
