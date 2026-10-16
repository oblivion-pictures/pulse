/**
 * „Der Sicherungs-Stand dieses Geräts hat sich geändert" — ein Signal statt
 * eines Takts, importfrei (s. `pnpm test:unit`-Falle in CLAUDE.md).
 *
 * **Wofür:** Die DM-Seite zeigt einen Hinweis, solange auf DIESEM Gerät
 * keine Sicherung läuft (`routes/app/@me/[[dmChannelId]]/+page.svelte`). Bis
 * 2026-10-17 prüfte sie dafür alle 10 s zwei IndexedDB-Stände — endlos für
 * jeden, der die Sicherung nie einschaltet, also gerade für die, die den
 * Hinweis nicht interessiert. Jetzt melden die Schreibstellen selbst, und die
 * Seite prüft nur noch auf Anlass.
 *
 * **Wer meldet:** genau die Stellen, die den Stand in IndexedDB ändern —
 * `ziele.ts::zieleSchreiben`/`zieleLeeren` (Ziele) und
 * `geraete.ts::dekZwischenlagern`/`dekZwischenlagerWischen` (Schlüssel).
 * Wer eine weitere Schreibstelle baut, meldet dort ebenfalls; sonst bleibt
 * der Hinweis bis zum nächsten Sichtbarwerden der Seite stehen (das prüft die
 * Seite zusätzlich, als Netz für alles, was dieses Signal nicht erreicht).
 *
 * **Auch über Tabs hinweg** (`BroadcastChannel`): richtet jemand die
 * Sicherung in einem zweiten Fenster ein, das neben diesem steht, wird
 * dieses nie verdeckt — ohne Kanal verschwände der Hinweis dort nicht.
 */

const EREIGNIS = 'pulse-sicherung-geaendert';
const KANAL_NAME = 'pulse-sicherung-zustand';

const lokal = new EventTarget();
let kanal: BroadcastChannel | null = null;
let hoererZahl = 0;

const hatKanal = (): boolean => typeof BroadcastChannel !== 'undefined';

/** Nach jeder Änderung des Sicherungs-Stands rufen. Synchron für diesen Tab. */
export function sicherungGeaendert(): void {
	lokal.dispatchEvent(new Event(EREIGNIS));
	if (!hatKanal()) return;
	if (kanal) {
		kanal.postMessage(1);
		return;
	}
	// Hört hier niemand zu, braucht es keinen Dauer-Kanal — eine schon
	// verschickte Nachricht erreicht die anderen Tabs auch nach `close()`.
	const einmal = new BroadcastChannel(KANAL_NAME);
	einmal.postMessage(1);
	einmal.close();
}

/** Hörer anmelden; gibt die Abmeldung zurück (mehrfaches Abmelden ist folgenlos). */
export function beiSicherungAenderung(hoerer: () => void): () => void {
	const f = (): void => hoerer();
	lokal.addEventListener(EREIGNIS, f);
	if (hoererZahl++ === 0 && hatKanal()) {
		kanal = new BroadcastChannel(KANAL_NAME);
		kanal.onmessage = () => lokal.dispatchEvent(new Event(EREIGNIS));
	}
	let aktiv = true;
	return () => {
		if (!aktiv) return;
		aktiv = false;
		lokal.removeEventListener(EREIGNIS, f);
		if (--hoererZahl === 0) {
			kanal?.close();
			kanal = null;
		}
	};
}
