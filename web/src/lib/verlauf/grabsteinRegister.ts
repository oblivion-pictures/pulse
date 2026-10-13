/**
 * Das Grabstein-Register: welche Nachrichten auf diesem Gerät gelöscht
 * sind — je Konto, Kanal, AUTOR und kanonischer Kennung
 * (`identitaet.ts::kanonischeId`), unabhängig davon, unter welcher lokalen
 * ID sie hier lagen oder ob sie überhaupt lagen.
 *
 * **Warum es das braucht** (Gegenprüfung 2026-10-12, Fund 1). Ein Grabstein
 * war bis hierher ein SATZ: die gelöschte Nachricht unter ihrer lokalen ID,
 * mit `geloescht: true`. Dieselbe Nachricht liegt auf einem Gerät aber unter
 * mehreren lokalen IDs (Zustellungs-ID D beim Empfang, Kennung K aus dem
 * Archiv, aus der Sicherung oder vom alten Gerät). Kam eine Kopie unter K
 * erst NACH der Löschung — Archiv-Nachzug, Sicherungs-Seite, Kopplung —,
 * war sie ein neuer, sichtbarer Satz, und der Grabstein unter D half nichts.
 * Dasselbe, wenn eine Löschung ankam, bevor die Nachricht überhaupt lag.
 * Das Register merkt sich deshalb die LÖSCHUNG, nicht den Satz, und jeder
 * Schreibweg legt eine Nachricht, deren Identität dort steht, als Grabstein
 * ab (`dbRegister.ts::ablegenMitRegister`).
 *
 * **Nur gebundene Löschungen tragen ein.** Ein Eintrag entsteht, wo der
 * Autor feststeht: ein Lösch-Frame (Absender aus der Zustellung), eine
 * Grabstein-Zeile im Archiv (Einlieferer = Autor), ein Sicherungs-Stein, der
 * seinen Autor nennt, die eigene Löschung eines liegenden Satzes (Autor aus
 * dem Satz), ein übernommener Grabstein-Satz der Kopplung (Autor aus dem
 * Satz, außer er trägt `loeschungUngebunden`). Nie über eine bloße ID: die Kennung wählt der Absender frei, und
 * ohne den Autor im Schlüssel könnte jeder Gesprächspartner fremde
 * Nachrichten vorab „löschen".
 *
 * **Kein eigener Objektspeicher, mit Absicht.** Ein neuer Speicher ginge nur
 * über eine höhere `DB_VERSION`, und an genau der zerstörte
 * `verbindung.ts::openVerlaufDb` bis 2026-10-12 den Bestand: ein noch offener
 * Tab mit der älteren Fassung bekam beim nächsten Öffnen `VersionError`, und
 * die „Fassungs-Stau-Heilung" dort LÖSCHTE daraufhin die ganze Datenbank —
 * für verschlüsselte Nachrichten die einzige Kopie. Seither ist sie
 * entschärft, aber Klienten mit dem alten Code laufen noch (Kommentar zu
 * `DB_VERSION` in `schema.ts`). Die Einträge liegen deshalb im Speicher
 * `nachrichten`, unter einem Schlüssel mit eigenem Präfix, und ohne die
 * Felder `kanalId` und `kontoId`. Das hält sie aus jedem bestehenden Leseweg
 * heraus: die Kanal-Bereiche beginnen mit der Kanal-ID (Ziffern,
 * `satz.ts::sortierSchluessel`), `~` sortiert hinter jeder davon; die vollen
 * Scans filtern über `kontoFilter.ts::gehoertZuKonto`, und das lehnt einen
 * Satz ohne `kontoId` ab; der Index `nach_kanal` überspringt Zeilen ohne
 * `kanalId`. Wer einen neuen Leseweg über `nachrichten` baut, filtert
 * ebenso — oder prüft mit `istRegisterEintrag`.
 *
 * Importfrei bis auf die `.ts`-Pfade der Identitäts- und Kontoregel (Nodes
 * Testläufer).
 */
import { istGueltigeKennung, kanonischeId, nachrichtIdentitaet } from './identitaet.ts';
import { gehoertZuKonto } from './kontoFilter.ts';

/** Präfix der Register-Schlüssel — sortiert hinter jeder Kanal-ID. */
const PRAEFIX = '~grabstein|';

/** Ein Eintrag des Registers, wie er im Speicher `nachrichten` liegt. */
export type RegisterEintrag = {
  schluessel: string;
  grabstein: { konto: string; kanal: string; autor: string; kennung: string };
};

/** Der Schlüssel eines Eintrags, oder `null`, wenn die Löschung nicht
 *  gebunden ist (kein Konto, Autor oder Kennung, die keine Kennung ist).
 *  Autor und Kennung müssen die Form einer Kennung haben
 *  (`identitaet.ts::istGueltigeKennung`): die Kennung wählt der Absender frei,
 *  und ein Eintrag mit beliebigem Wert flutete den Speicher und landete als
 *  Stein in der Sicherung (Gegenprüfung 2026-10-12, Fund 1). */
export function registerSchluessel(
  kontoId: string,
  kanalId: string,
  autorId: string,
  kennung: string
): string | null {
  if (kontoId === '' || !istGueltigeKennung(autorId) || !istGueltigeKennung(kennung)) return null;
  return `${PRAEFIX}${kontoId}|${kanalId}|${nachrichtIdentitaet(autorId, kennung)}`;
}

/** Der Eintrag für eine gebundene Löschung, oder `null` (s. `registerSchluessel`). */
export function registerEintrag(
  kontoId: string,
  kanalId: string,
  autorId: string,
  kennung: string
): RegisterEintrag | null {
  const schluessel = registerSchluessel(kontoId, kanalId, autorId, kennung);
  if (schluessel === null) return null;
  return { schluessel, grabstein: { konto: kontoId, kanal: kanalId, autor: autorId, kennung } };
}

/** Der Ausschnitt eines Satzes, aus dem sich seine Identität ergibt. */
type SatzIdentitaet = {
  kontoId: string;
  kanalId: string;
  autorId: string;
  nachrichtId: string;
  kryptoId?: string | null;
};

/** Der Eintrag für die Löschung DIESES Satzes — sein Autor und seine
 *  kanonische Kennung. */
export function registerEintragFuerSatz(satz: SatzIdentitaet): RegisterEintrag | null {
  return registerEintrag(
    satz.kontoId ?? '',
    satz.kanalId,
    satz.autorId ?? '',
    kanonischeId(satz.nachrichtId, satz.kryptoId)
  );
}

/** Der Register-Schlüssel, unter dem die Löschung DIESES Satzes stünde
 *  (s. `registerEintragFuerSatz`). */
export function registerSchluesselFuerSatz(satz: SatzIdentitaet): string | null {
  return registerEintragFuerSatz(satz)?.schluessel ?? null;
}

/** Ein Grabstein-Satz, wie ihn die Kopplung vom alten Gerät übernimmt. */
type UebernommenerStein = SatzIdentitaet & {
  schluessel: string;
  geloescht: boolean;
  loeschungUngebunden?: true;
};

/**
 * Was die übernommenen Grabsteine einer Kopplung bewirken
 * (`dbLoeschen.ts::verlaufRegisterAbgleichen`): für jeden gebundenen ein
 * Register-Eintrag (Autor und Kennung aus dem Satz), für jeden ungebundenen
 * (`loeschungUngebunden`) nur sein eigener Schlüssel — er trifft auf diesem
 * Gerät wie auf dem alten nur den Satz unter seiner lokalen ID.
 */
export function uebernommeneLoeschungen(
  grabsteine: readonly UebernommenerStein[],
  kontoId: string
): { eintraege: RegisterEintrag[]; nurSelbst: Set<string> } {
  const eintraege: RegisterEintrag[] = [];
  const nurSelbst = new Set<string>();
  for (const satz of grabsteine) {
    if (!satz.geloescht || !gehoertZuKonto(satz, kontoId)) continue;
    if (satz.loeschungUngebunden) {
      nurSelbst.add(satz.schluessel);
      continue;
    }
    const eintrag = registerEintragFuerSatz(satz);
    if (eintrag !== null) eintraege.push(eintrag);
  }
  return { eintraege, nurSelbst };
}

/** Ob eine Zeile des Speichers `nachrichten` ein Register-Eintrag ist. */
export function istRegisterEintrag(zeile: unknown): zeile is RegisterEintrag {
  const schluessel = (zeile as { schluessel?: unknown } | null)?.schluessel;
  return typeof schluessel === 'string' && schluessel.startsWith(PRAEFIX);
}

/**
 * Die Fassung, in der ein Nachschub abgelegt wird, dessen Identität im
 * Register steht: als Grabstein, ohne Inhalt und ohne Anhänge — gelöscht
 * heißt gelöscht, auch für eine Kopie, die erst danach ankommt. Autor und
 * Kennung bleiben, sonst fände das nächste Ergänzen den Satz nicht wieder.
 */
export function alsGrabstein<S extends { geloescht: boolean; inhalt: string; anhaenge: unknown[] }>(
  satz: S
): S {
  return { ...satz, geloescht: true, inhalt: '', anhaenge: [] };
}
