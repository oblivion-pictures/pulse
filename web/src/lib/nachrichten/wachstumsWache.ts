/**
 * Der Messungs-Wächter der Nachrichtenliste — die reine Rechnung und der
 * Taktgeber hinter `MessageList.svelte`, importfrei bis auf den Takt-Helfer
 * (s. `pnpm test:unit`-Falle in CLAUDE.md).
 *
 * **Was er tut (unverändert seit vor 2026-10-17):** virtua misst Zeilen erst
 * beim Rendern nach, die Inhaltshöhe wächst also UNTER einem unten klebenden
 * Nutzer (48er-Schätzung gegen reale Medienhöhen). Alle 250 ms vergleicht der
 * Wächter die Inhaltsgrösse mit der zuletzt gesehenen; ist sie bei klebendem
 * Nutzer um mehr als 10 px gewandert, zieht er ans Ende nach. Wer nicht klebt,
 * wird nie gezogen — bei ihm merkt er sich nur die Grösse.
 *
 * **Was sich am 2026-10-17 geändert hat: nur, WANN er tickt.** Bis dahin lief
 * der 250-ms-Takt, solange irgendein Chat offen war — vier Weckungen je
 * Sekunde auch im völligen Leerlauf, und in einem verdeckten Tab mit 1 Hz.
 * Jetzt läuft er nur nach einem Wachstums-ANLASS und noch `NACHLAUF_MS`
 * darüber hinaus. Anlässe meldet die Liste: eine Grössenänderung des
 * Inhaltsbehälters von virtua (dessen Höhe IST die Inhaltsgrösse; wie sie
 * beobachtet wird, s. `wacheAnListe`), des Sichtfensters,
 * ein nachgeladenes Bild, neue Nachrichten, ein Scroll. Bei verdeckter Seite
 * tickt er nicht; das Sichtbarwerden ist selbst ein Anlass.
 *
 * **Warum das nichts auslässt:** Ein Tick ändert nur dann etwas, wenn sich
 * die Grösse seit dem letzten Tick geändert hat — und jede Grössenänderung
 * ist ein Anlass. Der letzte Tick eines Anlasses liegt höchstens einen Takt
 * nach der letzten Änderung, also innerhalb des Nachlaufs; die gemerkte
 * Grösse ist danach dieselbe, die ein Dauertakt gemerkt hätte. Die
 * Klebe-Logik selbst (`klebezustand.ts`) ist davon unberührt.
 */

import { browserUmgebung, type TaktUmgebung } from '../utils/sichtbarerTakt.ts';

export const WACHE_TAKT_MS = 250;
/** So lange tickt er nach dem letzten Anlass weiter (acht Takte). */
export const NACHLAUF_MS = 2000;
/** Unter dieser Wanderung zieht er nicht nach (Subpixel-/Rundungsrauschen). */
export const WANDER_SCHWELLE_PX = 10;

/**
 * Ein Tick. `groesse === null` heisst „keine Liste / keine Zeilen" — dann
 * vergisst er die gemerkte Grösse (0), wie vorher.
 */
export function wachenTick(
	letzte: number,
	groesse: number | null,
	klebt: boolean
): { letzte: number; nachziehen: boolean } {
	if (groesse === null) return { letzte: 0, nachziehen: false };
	if (!klebt) return { letzte: groesse, nachziehen: false };
	if (Math.abs(groesse - letzte) > WANDER_SCHWELLE_PX) return { letzte: groesse, nachziehen: true };
	return { letzte, nachziehen: false };
}

/** Tickt er nach diesem Tick weiter? */
export function wacheLaeuftWeiter(scharfBis: number, jetzt: number, verdeckt: boolean): boolean {
	return !verdeckt && jetzt < scharfBis;
}

export type WachstumsWache = {
	/** Ein Wachstums-Anlass: für `NACHLAUF_MS` scharf schalten (bzw. verlängern). */
	anlass(): void;
	/** Endgültig aus; danach sind Anlässe folgenlos. */
	stop(): void;
};

/**
 * `tick` ist der eigentliche Wächter-Durchgang der Liste (liest Grösse und
 * Klebezustand, ruft `wachenTick`, zieht nach). `dauerhaft` = ohne
 * Anlass-Melder (kein `MutationObserver` im Browser): dann tickt er wie früher
 * ständig — nur bei verdeckter Seite nicht.
 */
export function wachstumsWache(
	tick: () => void,
	{ dauerhaft = false, umgebung = browserUmgebung() }: { dauerhaft?: boolean; umgebung?: TaktUmgebung } = {}
): WachstumsWache {
	let scharfBis = 0;
	let griff: unknown = null;
	let aus = false;

	const takt = (): void => {
		griff = null;
		if (aus) return;
		const jetzt = umgebung.jetzt();
		if (wacheLaeuftWeiter(dauerhaft ? Infinity : scharfBis, jetzt, umgebung.verdeckt())) {
			griff = umgebung.setTimeout(takt, WACHE_TAKT_MS);
		}
		tick();
	};

	const anlass = (): void => {
		if (aus || umgebung.verdeckt()) return;
		scharfBis = umgebung.jetzt() + NACHLAUF_MS;
		if (griff === null) griff = umgebung.setTimeout(takt, WACHE_TAKT_MS);
	};

	const abmelden = umgebung.beiSichtwechsel(anlass);
	anlass();

	return {
		anlass,
		stop() {
			aus = true;
			if (griff !== null) umgebung.clearTimeout(griff);
			griff = null;
			abmelden();
		}
	};
}

/**
 * Die Verdrahtung an der echten Liste: `wurzel` ist der Rahmen um die VList,
 * die VList trägt die Klasse `nachrichten-scroller` (nur als Fundstelle, ohne
 * CSS-Regel), ihr erstes Kind ist virtuas Inhaltsbehälter. Virtua schreibt
 * dessen Höhe (= `getScrollSize()`) als Inline-Stil — jede Messkorrektur ist
 * also eine Änderung seines `style`-Attributs.
 *
 * **Ein `MutationObserver`, kein `ResizeObserver`:** Mit einem
 * `ResizeObserver` auf dem Behälter meldete Chromium im E2E-Lauf vom
 * 2026-10-17 dutzendfach „ResizeObserver loop completed with undelivered
 * notifications" (als Fehler im Fenster). Ursache: virtuas eigener
 * Beobachter auf den (tieferen) Zeilen ändert in seinem Rückruf die Höhe des
 * (flacheren) Behälters, und eine solche Meldung schiebt der Browser in den
 * nächsten Frame und wirft dabei den Fehler. Die Attribut-Meldung kommt als
 * Mikroaufgabe und kennt diese Regel nicht.
 *
 * Der Behälter entsteht neu, wenn die Liste zwischen leer und nicht leer
 * wechselt — deshalb sieht jeder Anstoss und jeder Tick nach, ob noch
 * derselbe beobachtet wird.
 */
export function wacheAnListe(
	wurzel: Element,
	liste: { groesse(): number | null; klebt(): boolean; nachziehen(): void }
): WachstumsWache {
	const hatMo = typeof MutationObserver !== 'undefined';
	let inhalt: Element | null = null;
	const inhaltMo = hatMo ? new MutationObserver(() => wache.anlass()) : null;
	const beobachten = (): void => {
		const neu = wurzel.querySelector('.nachrichten-scroller')?.firstElementChild ?? null;
		if (neu === inhalt || !inhaltMo) return;
		inhaltMo.disconnect();
		inhalt = neu;
		if (inhalt) inhaltMo.observe(inhalt, { attributes: true, attributeFilter: ['style'] });
	};
	let letzte = 0;
	const wache = wachstumsWache(
		() => {
			beobachten();
			const r = wachenTick(letzte, liste.groesse(), liste.klebt());
			letzte = r.letzte;
			if (r.nachziehen) liste.nachziehen();
		},
		{ dauerhaft: !hatMo }
	);
	beobachten();
	return {
		anlass() {
			beobachten();
			wache.anlass();
		},
		stop() {
			wache.stop();
			inhaltMo?.disconnect();
		}
	};
}
