/**
 * Zwischenspeicher für die Verzeichnis-Auskunft EINES Abholzyklus —
 * importfrei, damit Nodes Testläufer ihn direkt prüft (s. CLAUDE.md „Die
 * Falle"); angeschlossen in `empfangen.ts` (anlegen je Zyklus) und
 * `empfangsbindung.ts` (lesen je Zustellung).
 *
 * **Der Befund** (DM-Bughunt 2026-11-02, Fund 3): `absenderBinden` fragte
 * das Schlüsselverzeichnis für JEDEN Aufbau-Umschlag (Art 0) neu nach dem
 * Absender. Solange keine Antwort zurückgeht, ist jede weitere Nachricht
 * desselben Geräts wieder ein Aufbau-Umschlag — wer nach Tagen öffnet, hat
 * leicht 60 davon im Postfach. Ab dem 61. antwortete der Server mit 429
 * (`keys_buendel_auskunft`, 60 je Minute), die Bindung ging auf `spaeter`,
 * und der Rest blieb bis zum nächsten Auslöser liegen.
 *
 * **Die Regel:** je Schlüssel (das Absender-Konto) höchstens EIN Abruf je
 * Zyklus. Auch ein gescheiterter Abruf bleibt für den Rest des Zyklus
 * stehen — sonst fragte jede weitere Zustellung erneut und lief in dieselbe
 * Bremse. `aufgeschoben` meldet dem Aufrufer, dass etwas wegen eines
 * gescheiterten Abrufs liegen blieb; er plant dann einen Nachlauf.
 *
 * Ein Zyklus dauert Sekunden; ein Gerät, das in dieser Zeit widerrufen wird,
 * fällt mit dem nächsten Zyklus aus der Auskunft. Länger als ein Zyklus wird
 * nichts gemerkt.
 */
export type ZyklusSpeicher<T> = {
  holen(schluessel: string): Promise<T>;
  /** `true`, sobald ein Abruf dieses Zyklus gescheitert ist. */
  readonly aufgeschoben: boolean;
};

export function zyklusSpeicherAnlegen<T>(
  laden: (schluessel: string) => Promise<T>
): ZyklusSpeicher<T> {
  const abrufe = new Map<string, Promise<T>>();
  let aufgeschoben = false;
  return {
    holen(schluessel) {
      let abruf = abrufe.get(schluessel);
      if (!abruf) {
        abruf = laden(schluessel);
        abruf.catch(() => {
          aufgeschoben = true;
        });
        abrufe.set(schluessel, abruf);
      }
      return abruf;
    },
    get aufgeschoben() {
      return aufgeschoben;
    }
  };
}
