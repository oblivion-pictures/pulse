/**
 * Wann der Diagnose-Upload (`experimental-log-upload.ts`) ausgelöst wird —
 * als reine Entscheidung, ohne `electron`-Import und ohne echte Uhr (die
 * Zeitplanung kommt herein), damit sie ohne App prüfbar ist.
 *
 * **Warum es diese Datei gibt** (2026-10-15): bis dahin löste allein das
 * `stopped`-Ereignis den Upload aus, ein vorheriges `error` setzte nur den
 * Grund. Zwei der drei Sidecars schicken nach einem Fehler aber absichtlich
 * KEIN `stopped` — der Terminalzustand soll `error` bleiben, sonst zeigte die
 * Oberfläche „Beendet" statt des roten Fehlers:
 *
 * - Windows (`win-hq-sidecar/src/stream_controller/mod.rs`, `worker_finished`):
 *   `state:error`, dann `error`, kein `stopped`.
 * - Linux (`linux-hq-sidecar/src/stream_controller.rs`, Worker-Ende und
 *   `WorkerDoneGuard`): `error`, dann `state:error`, kein `stopped`.
 * - macOS (`mac-hq-sidecar/src/stream_controller.rs`): `error`,
 *   `state:error`, danach doch `state:stopped` und `stopped`. Nur bei einer
 *   Panik des Stream-Fadens fehlt `stopped` auch dort.
 *
 * Folge: auf Windows und Linux kam von genau den Streams, die mit einem Fehler
 * endeten, nie ein Bericht — nur ein Absturz des ganzen Prozesses ging durch,
 * weil `sidecar.ts` dann ein `stopped` nachreicht.
 *
 * **Die Regel jetzt:** ein `error` plant den Upload mit Grund `error` nach
 * {@link NACHLAUF_MS}. Kommt in dieser Zeit `stopped` (macOS), geht der Upload
 * sofort und nur einmal. Die Wartezeit hat zwei Gründe: der Zustandsrahmen,
 * den Linux NACH dem `error` schreibt, soll noch im Log-Ausschnitt stehen, und
 * macOS soll nicht zwei Berichte für denselben Fehler schicken.
 *
 * **Bewusst ohne Ausnahme für `capture_size_changed`** (Windows, Quelle
 * ändert ihre Auflösung): die Oberfläche startet danach zwar oft selbst neu
 * (`web/src/lib/stream/autoRestart.ts`), aber nicht immer — höchstens zweimal
 * je Minute und nur mit gemerktem Start. Bliebe der Neustart aus, fehlte sonst
 * genau dieser Bericht.
 *
 * **Höchstens ein Fehlerbericht je Slot und {@link FEHLER_ABSTAND_MS}:** eine
 * Schleife aus Fehler und Neustart (Größenwechsel, Standplatz-Gerät, an das
 * Zuschauer immer wieder neu verbinden) brächte sonst alle paar Sekunden
 * denselben Bericht. Der Server nimmt nur 30 je Stunde und IP an
 * (`routes_experimental_logs.py`); hinter einer geteilten Adresse (Büro,
 * CGNAT) gingen dann auch die Berichte anderer Rechner verloren. Der erste
 * Bericht einer Schleife trägt die Ursache, die weiteren nichts Neues. Ein
 * sauberes Ende (`stopped` ohne Fehler) ist davon nicht betroffen.
 */

/** Wartezeit zwischen `error` und Upload, wenn kein `stopped` folgt. */
export const NACHLAUF_MS = 2_000;

/** Mindestabstand zwischen zwei Fehlerberichten desselben Slots. */
export const FEHLER_ABSTAND_MS = 60_000;

export type UploadGrund = 'stream_end' | 'error';

/** Plant `fn` nach `ms`; die Rückgabe bricht die Planung ab. */
export type Planer = (fn: () => void, ms: number) => () => void;

export type SidecarEreignis = { ev?: string };

/**
 * Baut den Auslöser. `senden` wird je Stream-Ende höchstens einmal gerufen;
 * ob die Übermittlung eingeschaltet ist, prüft der Aufrufer darin selbst.
 * `jetzt` liefert Millisekunden (monoton genügt).
 */
export function createUploadAusloeser(
  senden: (grund: UploadGrund, slot: number) => void,
  planen: Planer,
  jetzt: () => number,
): (ev: SidecarEreignis, slot: number) => void {
  // Pro Slot: kam seit dem letzten Ende ein Fehler? → bestimmt den Grund.
  const sahFehler = new Set<number>();
  // Pro Slot: der geplante Upload nach einem Fehler, solange er aussteht.
  const ausstehend = new Map<number, () => void>();
  // Pro Slot: wann zuletzt ein Fehlerbericht ging. Fehlender Eintrag = noch
  // keiner (bewusst nicht `0`, s. `sidecar-log-noise.ts`).
  const letzterFehlerbericht = new Map<number, number>();

  const sendeFehler = (slot: number) => {
    const t = jetzt();
    const vorher = letzterFehlerbericht.get(slot);
    if (vorher !== undefined && t - vorher < FEHLER_ABSTAND_MS) return;
    letzterFehlerbericht.set(slot, t);
    senden('error', slot);
  };

  return (ev, slot) => {
    if (ev.ev === 'error') {
      sahFehler.add(slot);
      // Ein zweites `error` vor Ablauf plant nicht neu: es ist derselbe
      // Ausfall, und der Ausschnitt wird beim Senden ohnehin frisch gelesen.
      if (ausstehend.has(slot)) return;
      ausstehend.set(
        slot,
        planen(() => {
          ausstehend.delete(slot);
          sahFehler.delete(slot);
          sendeFehler(slot);
        }, NACHLAUF_MS),
      );
      return;
    }
    if (ev.ev !== 'stopped') return;

    ausstehend.get(slot)?.();
    ausstehend.delete(slot);
    if (sahFehler.delete(slot)) sendeFehler(slot);
    else senden('stream_end', slot);
  };
}
