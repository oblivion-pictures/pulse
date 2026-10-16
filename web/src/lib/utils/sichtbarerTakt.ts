/**
 * Ein Takt, der bei verdeckter Seite schläft und beim Sichtbarwerden
 * nachholt, was in der Zwischenzeit fällig geworden wäre — importfrei
 * (s. `pnpm test:unit`-Falle in CLAUDE.md).
 *
 * **Wofür:** Mehrere Takte der App (Verbindungs-Spiegel, App-Host-Abfrage,
 * Ablage-Festigung, Beschwerde-Zähler) bedienen nur Anzeigen oder holen
 * Bestände nach, die beim nächsten Lauf ohnehin vollständig gesehen werden.
 * Bei verdeckter Seite (Tab im Hintergrund, App weggesteckt) hat niemand
 * etwas von ihnen; sie weckten trotzdem die CPU, teils mit Netzanfrage.
 *
 * **Nachholen statt Neustart:** Beim Sichtbarwerden läuft der Takt nur dann
 * SOFORT, wenn sein Abstand seit dem letzten Lauf schon um ist; sonst kommt
 * er genau dann, wann er auch ohne Pause gekommen wäre. Ein Takt verpasst
 * also höchstens die Läufe, die in die verdeckte Zeit fielen, und kommt nie
 * öfter als ohne Pause — ein schnelles Hin- und Herschalten zwischen Tabs
 * löst keine Anfragen-Salve aus.
 *
 * **Was NICHT hierher gehört:** alles, wovon der Server oder die Zustellung
 * abhängt, auch bei verdeckter Seite — der WS-Herzschlag (der Server hält
 * einen Socket nach 95 s Stille für tot) und die Postfach-Weckrufe.
 *
 * Eine Seite ohne `document` (Node, Tests ohne Umgebung) gilt als sichtbar:
 * dann läuft der Takt wie ein gewöhnliches Intervall.
 */

export type TaktUmgebung = {
	jetzt(): number;
	verdeckt(): boolean;
	/** Meldet jeden Sichtbarkeitswechsel; gibt die Abmeldung zurück. */
	beiSichtwechsel(hoerer: () => void): () => void;
	setTimeout(f: () => void, ms: number): unknown;
	clearTimeout(griff: unknown): void;
};

/**
 * Wie lange bis zum nächsten Lauf? `null` = es gab noch keinen (also sofort).
 * Nie negativ: ein überfälliger Lauf kommt sofort, nicht „vor der Zeit".
 */
export function wartezeit(letzterLauf: number | null, jetzt: number, taktMs: number): number {
	if (letzterLauf === null) return 0;
	return Math.max(0, letzterLauf + taktMs - jetzt);
}

/** Die echte Umgebung: `document.hidden`, `visibilitychange`, Fenster-Timer. */
export function browserUmgebung(): TaktUmgebung {
	const doc = typeof document === 'undefined' ? null : document;
	return {
		jetzt: () => Date.now(),
		verdeckt: () => doc?.hidden === true,
		beiSichtwechsel(hoerer) {
			if (!doc) return () => {};
			doc.addEventListener('visibilitychange', hoerer);
			return () => doc.removeEventListener('visibilitychange', hoerer);
		},
		setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
		clearTimeout: (griff) => globalThis.clearTimeout(griff as ReturnType<typeof setTimeout>)
	};
}

export type TaktOptionen = {
	/** Ersten Lauf sofort (synchron) beim Start — wie `f(); setInterval(f)`.
	 *  Vorgabe `true`. `false` = erster Lauf nach einem vollen Abstand. */
	sofort?: boolean;
	umgebung?: TaktUmgebung;
};

/**
 * Startet den Takt und gibt den Stopper zurück. `lauf` darf werfen oder ein
 * Promise liefern — der nächste Lauf ist vorher schon geplant, ein Fehler
 * hält den Takt nicht an (wie bei `setInterval`). Überlappung asynchroner
 * Läufe verhindert der Takt NICHT; wer sie ausschliessen muss, tut das wie
 * vorher selbst.
 */
export function sichtbarerTakt(
	lauf: () => unknown,
	taktMs: number,
	{ sofort = true, umgebung = browserUmgebung() }: TaktOptionen = {}
): () => void {
	let letzter: number | null = sofort ? null : umgebung.jetzt();
	let griff: unknown = null;
	let aus = false;

	const abbrechen = (): void => {
		if (griff !== null) {
			umgebung.clearTimeout(griff);
			griff = null;
		}
	};

	const feuern = (): void => {
		griff = null;
		if (aus || umgebung.verdeckt()) return;
		letzter = umgebung.jetzt();
		planen();
		try {
			void lauf();
		} catch (fehler) {
			// Nicht hier hochwerfen: der erste Lauf geschieht synchron im Start,
			// und ein Wurf dort nähme dem Aufrufer den Stopper eines Takts, der
			// längst weiter geplant ist. Sichtbar bleibt der Fehler trotzdem.
			queueMicrotask(() => {
				throw fehler;
			});
		}
	};

	// Verdeckt: nichts planen — der Sichtwechsel-Hörer plant neu. Ein fälliger
	// Lauf geht synchron (beim Start wie beim Sichtbarwerden), alles andere
	// über einen Timer genau auf seinen Termin.
	function planen(): void {
		abbrechen();
		if (aus || umgebung.verdeckt()) return;
		const ms = wartezeit(letzter, umgebung.jetzt(), taktMs);
		if (ms === 0) feuern();
		else griff = umgebung.setTimeout(feuern, ms);
	}

	const abmelden = umgebung.beiSichtwechsel(planen);
	planen();
	return () => {
		aus = true;
		abbrechen();
		abmelden();
	};
}
