/**
 * Gemeinsame Kunst-Umgebung für Takt-Tests (`TaktUmgebung`): eine Uhr mit
 * Hand-Vorspulen, Timer, die nur beim Vorspulen feuern, und eine
 * umschaltbare Sichtbarkeit. Keine Testdatei (läuft nicht über den Glob).
 */
import type { TaktUmgebung } from '../src/lib/utils/sichtbarerTakt.ts';

export function kunstUmgebung() {
	let jetzt = 0;
	let verdeckt = false;
	let naechsteId = 1;
	const timer = new Map<number, { faellig: number; f: () => void }>();
	const hoerer = new Set<() => void>();
	const umgebung: TaktUmgebung = {
		jetzt: () => jetzt,
		verdeckt: () => verdeckt,
		beiSichtwechsel(h) {
			hoerer.add(h);
			return () => hoerer.delete(h);
		},
		setTimeout(f, ms) {
			const id = naechsteId++;
			timer.set(id, { faellig: jetzt + ms, f });
			return id;
		},
		clearTimeout(id) {
			timer.delete(id as number);
		}
	};
	return {
		umgebung,
		/** Zeit vorspulen und alle fälligen Timer in Reihenfolge feuern. */
		spule(ms: number) {
			const ziel = jetzt + ms;
			for (;;) {
				let erster: [number, { faellig: number; f: () => void }] | null = null;
				for (const e of timer) if (e[1].faellig <= ziel && (!erster || e[1].faellig < erster[1].faellig)) erster = e;
				if (!erster) break;
				timer.delete(erster[0]);
				jetzt = erster[1].faellig;
				erster[1].f();
			}
			jetzt = ziel;
		},
		sicht(sichtbar: boolean) {
			verdeckt = !sichtbar;
			for (const h of [...hoerer]) h();
		},
		offeneTimer: () => timer.size,
		hoererZahl: () => hoerer.size
	};
}
