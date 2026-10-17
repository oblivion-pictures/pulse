/**
 * Die Weiche zum nativen Sprachweg auf iOS: trägt die installierte Hülle den
 * Raum (`iosSprache.ts`) vollständig?
 *
 * **In der iOS-Hülle gibt es keinen Rückfall auf LiveKit in der WebView mehr**
 * (Eigentümer-Entscheid E6, 2026-10-18; alle Tester laufen auf aktuellen
 * TestFlight-Bauten). Die Weiche ist damit keine Wahl mehr, sondern eine
 * Fähigkeitsprüfung: trägt der Bau den Weg nicht, tritt der Sprachkanal nicht
 * bei und sagt, dass die App aktualisiert werden muss (`sprachwegVeraltet`).
 * Im Browser — auch iPhone-Safari ohne Hülle — und am Desktop/Android bleibt
 * LiveKit in der WebView der normale Weg; dort liefert die Weiche `kein-ios`.
 *
 * **Eigene Datei, und mit `.ts`-Endungen in den Importen**, damit sie unter
 * Nodes Läufer GANZ lädt — samt echtem `@capacitor/core`
 * (`test/ios-sprache-weiche.test.ts`). Die Entscheidung ist die teuerste
 * Zeile des ganzen Wegs: eine falsche Antwort nimmt einem Telefon die Sprache,
 * und eine Prüfung, die nur ihre Annahmen nachstellt, hat das schon einmal
 * übersehen (Bughunt 2026-10-11, K1). `iosSprache.ts` reicht beide
 * Funktionen weiter; kein Aufrufer muss seinen Import ändern.
 */

import { huellenBefund } from './huelleKann.ts';
import {
  SPRACHE_FUNK_HQ_METHODEN,
  SPRACHE_METHODEN,
  SPRACHE_WACHE_METHODEN
} from './iosSpracheTypen.ts';
import { isCapacitorIOS } from './runtime.ts';

/** Wie die Weiche entschieden hat — und warum. Landet als
 *  `pulse.diag.weiche` im Speicher. */
export type WeichenBefund =
  | { nativ: true }
  | { nativ: false; grund: 'kein-ios' | 'kein-plugin' }
  | { nativ: false; grund: 'methoden-fehlen'; fehlen: string[] };

/**
 * Trägt diese App den nativen Weg — VOLLSTÄNDIG?
 *
 * **Gefragt wird die HÜLLE, nicht `Capacitor.Plugins`.** Bis zum 2026-10-11
 * stand hier `Plugins.SprachePlugin !== undefined` — und das war immer wahr:
 * `registerPlugin` in `iosSprache.ts` schreibt den Eintrag beim Import selbst
 * hinein, ob die Hülle das Plugin hat oder nicht (Bughunt 2026-10-11, K1).
 *
 * **Und es reicht nicht, dass das Plugin da ist.** Am selben Tag trug das
 * Telefon des Eigentümers ein `SprachePlugin` mit fünf Methoden
 * (`beitreten, verlassen, mikrofon, ausgabe, zustand`); die Oberfläche ruft
 * elf. Der Kern lehnt die fehlenden sofort ab (`UNIMPLEMENTED` — in Node
 * und im Simulator nachgestellt, s. `huelleKann.ts`; am Gerät nicht gesehen),
 * und die Aufrufer schlucken das: Taubstellen würde das Zeichen kippen und
 * allen „taub" melden, gehört würde weiter alles; die Kanalansicht ginge nie
 * auf, die Regler täten nichts. **Ein halber nativer Weg ist schlechter als der
 * frühere Web-Weg** — er sieht funktionierend aus, wo er es nicht ist. Deshalb
 * gilt: alle Methoden aus `SPRACHE_METHODEN`, oder der Bau gilt als veraltet.
 */
export function nativerSprachwegBefund(): WeichenBefund {
  if (!isCapacitorIOS()) return { nativ: false, grund: 'kein-ios' };
  const befund = huellenBefund('SprachePlugin', SPRACHE_METHODEN);
  if (befund.da) return { nativ: true };
  return befund.grund === 'methoden-fehlen'
    ? { nativ: false, grund: 'methoden-fehlen', fehlen: befund.fehlen }
    : { nativ: false, grund: 'kein-plugin' };
}

export function nativerSprachwegDa(): boolean {
  return nativerSprachwegBefund().nativ;
}

/**
 * Ist das eine iOS-Hülle, die den nativen Sprachweg NICHT (vollständig) trägt?
 * Dann darf der Sprachkanal nicht auf die WebView ausweichen, sondern die
 * Oberfläche verlangt die Aktualisierung über TestFlight. Nur der Befund einer
 * iOS-Hülle zählt — `kein-ios` (Browser, Desktop, Android) ist nie „veraltet".
 */
export function sprachwegVeraltet(befund: WeichenBefund): boolean {
  return !befund.nativ && befund.grund !== 'kein-ios';
}

/**
 * Trägt der Bau den Mikrofon-Wächter (seit 2026-10-17)? Nur auf dem nativen
 * Weg sinnvoll, und einzeln gefragt — Begründung an `SpracheWachePlugin`
 * (`iosSpracheTypen.ts`). An dieser Antwort hängen der Beitrittston nach dem
 * Mikrofon und der Diagnosebericht.
 */
export function nativeWacheDa(): boolean {
  return nativerSprachwegDa() && huellenBefund('SprachePlugin', SPRACHE_WACHE_METHODEN).da;
}

/**
 * Trägt der Bau den Bluetooth-HQ-Weg im nativen Sprachkanal (seit TestFlight
 * nach 8.1)? Nur dann gibt es den Schalter dafür; ein Bau ohne ihn zeigt ihn
 * nicht.
 */
export function nativeFunkHqDa(): boolean {
  return nativerSprachwegDa() && huellenBefund('SprachePlugin', SPRACHE_FUNK_HQ_METHODEN).da;
}
