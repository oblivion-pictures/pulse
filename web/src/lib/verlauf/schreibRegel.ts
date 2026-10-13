/**
 * Was ein Schreibweg über einen schon liegenden Satz schreiben darf, wenn
 * dieser einem ANDEREN Konto desselben Browserprofils gehört — importfrei bis
 * auf `.ts`-Pfade, damit Nodes Testläufer die Regel prüft (die Datenbank-
 * Wege selbst laufen dort nicht, `dbErgaenzen.ts`).
 *
 * **Zwei Konten, ein Profil.** Der Primärschlüssel eines Satzes ist
 * (Kanal, ID), ohne Konto (`satz.ts::sortierSchluessel`). Halten zwei Konten
 * dieselbe Nachricht unter derselben ID — Konto A seine eigene unter `K`,
 * Konto B dieselbe aus der Sicherung unter `K` —, schrieb der Nachschub des
 * einen den Satz des anderen blind über: der fremde zählte wie „liegt
 * nichts". Jetzt bleibt er stehen, und der Nachschub fällt weg. Preis: dem
 * zweiten Konto fehlt auf diesem Gerät diese eine Kopie. Richtig wäre das
 * Konto im Schlüssel; das ist ein Umschlüsseln der ganzen Datenbank.
 *
 * Ein Satz OHNE Konto (Altbestand, `kontoFilter.ts`) gehört niemandem und
 * darf überschrieben werden wie bisher — sonst hielte er seinen Platz für
 * immer, unsichtbar für jedes Konto.
 */
import type { Satz } from './schema';
import { gehoertZuKonto } from './kontoFilter.ts';
import { satzErgaenzen, type Nachschub } from './satz.ts';

/** Ob `satz` nachweislich einem anderen Konto als `kontoId` gehört. */
export function liegtFremdesKonto(satz: Pick<Satz, 'kontoId'>, kontoId: string): boolean {
  return typeof satz.kontoId === 'string' && satz.kontoId !== '' && satz.kontoId !== kontoId;
}

/** Die Fassung, die der Nachschub (Sicherung, Kopplung, Archiv) unter dem
 *  Schlüssel von `neu` ablegt, oder `null` für „nichts schreiben". */
export function nachschubFassung(
  vorhanden: Satz | undefined,
  neu: Satz,
  kontoId: string,
  herkunft: Nachschub
): Satz | null {
  if (vorhanden === undefined) return neu;
  if (liegtFremdesKonto(vorhanden, kontoId)) return null;
  return gehoertZuKonto(vorhanden, kontoId) ? satzErgaenzen(vorhanden, neu, herkunft) : neu;
}

/** Ob der Server-Weg (`db.ts::verlaufPutSaetze` mit `nurUeberKlartext`)
 *  `neu` über `vorhanden` schreiben darf: nicht über einen verschlüsselten
 *  Satz desselben Kontos (den kennt der Server nicht, `abgleich.ts`) und
 *  nicht über den Satz eines anderen Kontos. */
export function serverWegDarfSchreiben(vorhanden: Satz | undefined, neu: Satz): boolean {
  if (vorhanden === undefined) return true;
  if (liegtFremdesKonto(vorhanden, neu.kontoId)) return false;
  return !(vorhanden.verschluesselt && gehoertZuKonto(vorhanden, neu.kontoId));
}
