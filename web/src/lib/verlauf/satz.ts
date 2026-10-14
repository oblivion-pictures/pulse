/**
 * Nachricht → Satz des lokalen Verlaufs — importfrei bis auf den `.ts`-Pfad
 * der Kennungs-Regel, damit Nodes Testlaeufer sie sieht (kein
 * erweiterungsloser Laufzeit-Import moeglich).
 *
 * Die Satzform selbst (`Satz`) steht in `schema.ts`; hier nur der
 * strukturell identische Rueckgabetyp, um sie nicht importieren zu muessen.
 */
import { istGueltigeKennung } from './identitaet.ts';

type Satz = {
  schluessel: string;
  kanalId: string;
  nachrichtId: string;
  autorId: string;
  inhalt: string;
  erstelltAm: string;
  bearbeitetAm: string | null;
  geloescht: boolean;
  /** E2EE-Nachricht (2026-09-02): überlebt im Satz, damit die Löschen-/
   *  Bearbeiten-Gates auch nach einem Reload richtig verzweigen. */
  verschluesselt: boolean;
  anhaenge: unknown[];
  antwortAufId: string | null;
  kryptoId: string | null;
  /** S. `schema.ts::Satz.kontoId` — dieselbe Bedeutung, hier nur strukturell
   *  dupliziert (importfrei-Pflicht). */
  kontoId: string;
  /** S. `schema.ts::Satz.nichtZugestellt`. */
  nichtZugestellt?: boolean;
  /** S. `schema.ts::Satz.ungeprueft`. */
  ungeprueft?: true;
};

/**
 * Snowflakes sind Zeichenketten (JS `Number` kann 64 Bit nicht exakt
 * darstellen, s. CLAUDE.md). Ein IndexedDB-Schluessel sortiert lexikografisch
 * — ungepolstert stuende "10" vor "9". 20 Stellen reichen: die groesste
 * 64-Bit-Zahl hat 20 Dezimalstellen. Trennzeichen `:` kommt in keiner
 * Snowflake und keiner Kanal-ID vor (beide sind reine Ziffernfolgen).
 */
const ID_BREITE = 20;
const TRENNER = ':';

export function sortierSchluessel(kanalId: string, nachrichtId: string): string {
  return `${kanalId}${TRENNER}${nachrichtId.padStart(ID_BREITE, '0')}`;
}

/**
 * Wandelt eine rohe Nachricht (vom Server oder aus dem WS) in einen Satz um.
 * Fail-closed: fehlt ein Pflichtfeld oder hat es den falschen Typ, gibt es
 * `null` zurueck statt Muell abzulegen — sonst faellt der Fehler erst beim
 * Lesen auf, Wochen spaeter.
 *
 * Die ID muss eine Kennung sein (`identitaet.ts::istGueltigeKennung`), und
 * `kryptoId` und Antwortbezug zaehlen nur als Kennung (sonst `null`) — die
 * letzte Wand vor dem Ablegen, falls ein Leseweg eine frei gewaehlte Kennung
 * durchliesse (Gegenpruefung 2026-10-12, Fund 1: eine Kennung `"x"` brachte
 * den Sicherungs-Leser zum Absturz).
 *
 * `kontoId` kommt vom Aufrufer (`verlauf/index.ts`, ueber
 * `verlauf/konto.ts::aktuellesKonto`) — diese Datei ist importfrei und darf
 * den angemeldeten Nutzer nicht selbst ermitteln.
 */
export function zuSatz(kanalId: string, nachricht: unknown, kontoId: string): Satz | null {
  if (typeof nachricht !== 'object' || nachricht === null) return null;
  const n = nachricht as Record<string, unknown>;
  const { id, author_id, content } = n;
  if (!istGueltigeKennung(id) || typeof author_id !== 'string' || typeof content !== 'string') {
    return null;
  }
  const created_at = n.created_at;
  if (typeof created_at !== 'string') return null;
  const edited_at = typeof n.edited_at === 'string' ? n.edited_at : null;
  const deleted_at = typeof n.deleted_at === 'string' ? n.deleted_at : null;
  const anhaenge = Array.isArray(n.attachments) ? n.attachments : [];
  const antwortAufId = istGueltigeKennung(n.reply_to_id) ? n.reply_to_id : null;
  const kryptoId = istGueltigeKennung(n.krypto_id) ? n.krypto_id : null;

  return {
    schluessel: sortierSchluessel(kanalId, id),
    kanalId,
    nachrichtId: id,
    autorId: author_id,
    inhalt: content,
    erstelltAm: created_at,
    bearbeitetAm: edited_at,
    geloescht: deleted_at !== null,
    verschluesselt: n.verschluesselt === true,
    anhaenge,
    antwortAufId,
    kryptoId,
    kontoId,
    ...(n.nicht_zugestellt === true ? { nichtZugestellt: true } : {}),
    ...(n.archiv_ungeprueft === true ? { ungeprueft: true as const } : {})
  };
}

/**
 * Reduzierte Nachrichtenform fuer die sofortige Anzeige aus einem lokalen
 * Satz — strukturell ein Ausschnitt von `$lib/api/types::Message` (dessen
 * fehlende Felder dort optional sind), aber OHNE dessen Typ zu importieren
 * (importfrei-Pflicht, s. Modulkopf). Reaktionen und Erwaehnungen liegen lokal
 * nicht vor — sie fehlen, bis der Server-Abgleich sie nachliefert. Anhaenge
 * kommen seit Etappe E mit, aber NUR die verschluesselten (Begruendung bei
 * `verschluesselteAnhaenge`).
 */
export type SatzAlsNachricht = {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  nonce: null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  /** Wie `Message.krypto_id` (`api/types.ts`) — dort optional-ohne-`null`,
   *  deshalb `undefined` statt `null` bei Fehlen (s. `satzZuNachricht`). */
  krypto_id?: string;
  /** Wie `Message.nicht_zugestellt` — nur gesetzt, wenn es zutrifft. */
  nicht_zugestellt?: boolean;
  /** Reaktionen auf eine VERSCHLUESSELTE Nachricht in der Anzeige-Form von
   *  `Message.reactions` (strukturell `ReactionAggregate`). Rechnet nicht
   *  `satzZuNachricht` (das „ich" darin braucht das Konto, das diese Datei
   *  nicht kennen darf), sondern `verlauf/index.ts::verlaufLesen` aus
   *  `Satz.reaktionen` — Klartext-Saetze haben das Feld nie, ihre
   *  Reaktionen kommen vom Server. */
  reactions?: { emoji: string; count: number; me: boolean }[];
  /** Nur VERSCHLUESSELTE Anhaenge (Etappe E), s. `satzZuNachricht`.
   *  Strukturell der Ausschnitt von `$lib/api/types::Attachment`, den diese
   *  Datei ohne Import beschreiben kann — **mit jenem Typ synchron halten**,
   *  sonst faellt die Zuweisung an `Message.attachments` beim naechsten
   *  Pflichtfeld dort auseinander. */
  attachments?: {
    id: string;
    filename: string | null;
    mime: string | null;
    size: number;
    url: string;
    verschluesselt?: boolean;
  }[];
};

/**
 * Die verschluesselten Anhaenge eines Satzes — und NUR die.
 *
 * Ein Klartext-Anhang wird bewusst NICHT zurueckgegeben, obwohl `zuSatz` ihn
 * mit ablegt: seine `url` ist eine vorsignierte Adresse mit ~30 Minuten
 * Frist, aus dem lokalen Bestand also fast immer abgelaufen. Ihn hier
 * mitzuliefern wuerde den Klartext-Weg aendern (erst eine 403, dann ein
 * Nachsignieren, wo heute schlicht der Server-Bestand gilt) — und der darf
 * sich nicht aendern. Ein verschluesselter Anhang traegt dagegen gar keine
 * Adresse, sondern seinen Schluessel; er ist ohne den lokalen Bestand nach
 * einem Neustart nicht mehr auffindbar, weil der Server die Nachricht nie
 * gesehen hat.
 */
function verschluesselteAnhaenge(anhaenge: unknown[]): SatzAlsNachricht['attachments'] {
  const gefiltert = anhaenge.filter(
    (a): a is NonNullable<SatzAlsNachricht['attachments']>[number] =>
      typeof a === 'object' &&
      a !== null &&
      (a as Record<string, unknown>).verschluesselt === true &&
      typeof (a as Record<string, unknown>).id === 'string'
  );
  return gefiltert.length > 0 ? gefiltert : undefined;
}

/** Kehrt `zuSatz` um: aus einem lokalen Satz wird die Anzeige-Nachricht.
 *  `deleted_at` traegt bei einem Grabstein einen Zeitpunkt (Bearbeitungs-
 *  oder Erstellzeit als Naeherung — der echte Loeschzeitpunkt liegt lokal
 *  nicht vor), sonst `null`. Nur die Existenz eines Werts zaehlt bei den
 *  Aufrufern, nicht seine Genauigkeit. */
export function satzZuNachricht(satz: Satz): SatzAlsNachricht {
  return {
    id: satz.nachrichtId,
    channel_id: satz.kanalId,
    author_id: satz.autorId,
    content: satz.inhalt,
    nonce: null,
    created_at: satz.erstelltAm,
    edited_at: satz.bearbeitetAm,
    deleted_at: satz.geloescht ? (satz.bearbeitetAm ?? satz.erstelltAm) : null,
    ...(satz.verschluesselt ? { verschluesselt: true } : {}),
    reply_to_id: satz.antwortAufId ?? null,
    krypto_id: satz.kryptoId ?? undefined,
    ...(satz.nichtZugestellt ? { nicht_zugestellt: true } : {}),
    attachments: verschluesselteAnhaenge(satz.anhaenge ?? [])
  };
}

/** Die Anhang-ID eines abgelegten Anhangs, sonst `null` (Altbestand ohne
 *  Objektform oder ID). */
function anhangId(anhang: unknown): string | null {
  const id = (anhang as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

/** Die Anhang-IDs eines Satzes, oder `[]` — für die Lösch-Wege, die die
 *  zugehörigen Anhang-Bytes und Laufwerk-Dateien mitentfernen
 *  (`loeschFolgen.ts`).
 *
 *  Ein Anhang ohne gültige Kennung als `id` fällt heraus
 *  (`identitaet.ts::istGueltigeKennung`): aus der ID wird ein Dateiname im
 *  Laufwerk (`sicherung/geraete.ts::anhangDateiName`), und ein Altsatz von vor
 *  der Prüfung kann eine frei gewählte tragen (Gegenprüfung 2026-10-12,
 *  Fund 1). */
export function satzAnhangIds(satz: { anhaenge?: unknown[] } | undefined): string[] {
  const anhaenge = satz?.anhaenge;
  if (!Array.isArray(anhaenge)) return [];
  return anhaenge.map(anhangId).filter(istGueltigeKennung);
}

/**
 * Woher ein Nachschub kommt — und damit, wie viel er an einem liegenden Satz
 * ergänzen darf (`satzErgaenzen`):
 *
 *   - `sicherung`: die eigene Sicherung im eigenen Laufwerk. Geschrieben hat
 *     sie nur dieses Konto, verschlüsselt mit seinem eigenen Schlüssel; was
 *     sie über eine Nachricht weiß, stammt aus einem früheren eigenen Satz.
 *   - `kopplung`: der Verlauf des eigenen alten Geräts (`kopplung/empfangen.ts`)
 *     — eigene Wahrheit wie die Sicherung, und wird genauso behandelt.
 *   - `archiv`: das Server-Archiv. Jedes Mitglied des Kanals darf dort Zeilen
 *     einliefern, und den Autor nennt die Zeile nur in ihrer eigenen Nutzlast
 *     (`archiv/zeile.ts`). Eine Zeile mit dem Namen einer fremden Nachricht
 *     ist deshalb eine Behauptung, kein Nachweis.
 */
export type Nachschub = 'sicherung' | 'kopplung' | 'archiv';

/**
 * Führt einen neu ankommenden Satz mit dem zusammen, der unter demselben
 * Schlüssel schon liegt — für die Wege, die einen fremden Bestand
 * NACHLIEFERN (Sicherungs-Wiederherstellung, Kopplung, Server-Archiv), nicht
 * für den Empfang. Gibt die zu schreibende Fassung zurück, oder `null`, wenn
 * der liegende Satz so bleiben soll.
 *
 * **Ergänzen, nicht ersetzen, und nicht überspringen.** Bis 2026-10-11
 * schrieben beide Wege blind über den Schlüssel (`verlaufPutSaetze`): ein
 * Archiv-Satz ohne Löschung, Bearbeitung und Reaktionen überschrieb die
 * lokale Fassung — Gelöschtes kam zurück, Bearbeitungen und Reaktionen
 * waren weg, und ein Empfangs-Satz verlor seine `kryptoId`. Ein bloßes
 * Überspringen vorhandener Sätze ließe dagegen liegen, was der Nachschub
 * wirklich mehr weiß (die Kennung, einen Anhang).
 *
 *   - Ein Grabstein bleibt einer — der Nachschub kann ihn nicht aufheben.
 *   - Ein ungeprüfter Satz (`herkunft.ts`) wird durch jeden geprüften
 *     ersetzt, auch durch eine geprüfte Archiv-Zeile und auch durch den
 *     eines anderen Autors.
 *   - Sonst ist ein anderer Autor unter demselben Schlüssel nicht dieselbe
 *     Nachricht; der liegende Satz bleibt unangetastet, und der Nachschub
 *     fällt weg. Eine fremde Archiv-Zeile kann so nie einen liegenden Satz
 *     überschreiben, und einen fremden Platz besetzen kann sie auch nicht:
 *     sie liegt unter ihrer Zeilen-ID, die der Server vergibt (G2-3, Kopf
 *     von `archiv/zeile.ts`).
 *   - Inhalt, Bearbeitung, Reaktionen, Zustellstand: der liegende gewinnt —
 *     er ist auf diesem Gerät gepflegt worden, der Nachschub ist eine Kopie
 *     von früher.
 *   - `kryptoId`: der liegende, sonst der neue.
 *   - Nur aus eigener Wahrheit (Sicherung, Kopplung — nicht `archiv`): der
 *     Antwortbezug (der liegende, sonst der neue), `verschluesselt` (wenn
 *     einer von beiden es ist) und Anhänge, die der liegende nicht kennt
 *     (nach ID).
 *
 * **Warum das Archiv nur die Kennung ergänzen darf.** Ein Satz im Archiv
 * nennt seinen Autor selbst, und einliefern darf jedes Kanalmitglied. Die
 * erste Fassung dieser Funktion (2026-10-11, nie ausgeliefert) hängte die
 * Anhänge und den Antwortbezug einer solchen Zeile an den liegenden Satz
 * desselben Autors: der Partner lieferte eine Zeile mit der Kennung und dem
 * Namen MEINER Nachricht ein, und auf meinem Gerät zeigte meine Nachricht
 * danach sein Bild (`krypto/anhangHolen.ts`), und die nächste Erstsicherung
 * schrieb es als meines in die Sicherung. Die Kennung dagegen ändert nichts,
 * was angezeigt wird: eine Archiv-Zeile führt ihre `i` als Kennung
 * (`archiv/zeile.ts::leseZeile`), und unter `i` liegt sie nur als eigene
 * Zeile oder als Bestandszeile — dann ist das dieselbe ID wie die des
 * liegenden Satzes.
 *
 * Ergänzen löscht nie: ein neuer Satz mit `geloescht` hebt den liegenden
 * nicht auf (die Lösch-Wege laufen über `verlaufMarkiereGeloescht`), auch
 * keinen ungeprüften.
 */
export function satzErgaenzen<S extends Satz>(
  vorhanden: S,
  neu: Satz,
  herkunft: Nachschub
): S | null {
  if (vorhanden.geloescht) return null;
  const selberAutor = vorhanden.autorId === neu.autorId;
  // Ein ungeprüfter Satz (Archiv-Bestandszeile) weicht jedem geprüften ganz,
  // nie umgekehrt (`herkunft.ts`, Fund 4) — auch dem eines anderen Autors:
  // Schlüssel und Autor einer Bestandszeile wählte der Einliefernde frei, sie
  // darf keinen Platz besetzen (G2-3, Kopf von `archiv/zeile.ts`).
  if (vorhanden.ungeprueft && !neu.ungeprueft && !neu.geloescht) {
    return { ...neu, kryptoId: neu.kryptoId ?? (selberAutor ? vorhanden.kryptoId : null) } as S;
  }
  if (!selberAutor) return null;
  const kryptoId = vorhanden.kryptoId ?? neu.kryptoId;
  if (herkunft === 'archiv') {
    return kryptoId === vorhanden.kryptoId ? null : { ...vorhanden, kryptoId };
  }
  // Altsätze können Felder vermissen, die es bei ihrer Ablage noch nicht gab.
  const liegend = vorhanden.anhaenge ?? [];
  const bekannt = new Set(liegend.map(anhangId));
  const fehlend = neu.anhaenge.filter((a) => {
    const id = anhangId(a);
    return id !== null && !bekannt.has(id);
  });
  const antwortAufId = vorhanden.antwortAufId ?? neu.antwortAufId;
  const verschluesselt = vorhanden.verschluesselt || neu.verschluesselt;
  if (
    fehlend.length === 0 &&
    kryptoId === vorhanden.kryptoId &&
    antwortAufId === vorhanden.antwortAufId &&
    verschluesselt === vorhanden.verschluesselt
  ) {
    return null;
  }
  return {
    ...vorhanden,
    kryptoId,
    antwortAufId,
    verschluesselt,
    anhaenge: [...liegend, ...fehlend]
  };
}

/**
 * Legt die Sätze EINES Nachschubs zusammen, die denselben Schlüssel tragen —
 * mit derselben Regel wie gegen den liegenden Bestand (`satzErgaenzen`): der
 * erste gewinnt, ein späterer ergänzt ihn höchstens. Ein späterer Satz eines
 * anderen Autors fällt weg, wie gegen einen liegenden Satz.
 *
 * Gegenprüfung 2026-10-12, Fund 5: `verlaufSaetzeErgaenzen` stellte früher
 * alle Leseanfragen, bevor die erste Antwort kam, und sah die eigenen
 * Schreibvorgänge desselben Aufrufs nicht. Zwei Archiv-Zeilen mit derselben
 * ID liefen beide gegen „liegt nichts" und wurden beide geschrieben — die
 * spätere blind über die frühere. Heute legt `dbErgaenzen.ts` die Sätze
 * zusätzlich nacheinander ab, jeder sieht also den vorigen. Die Reihenfolge
 * bleibt die des ersten Auftretens.
 */
export function nachSchluesselVerdichten<S extends Satz>(saetze: S[], herkunft: Nachschub): S[] {
  const jeSchluessel = new Map<string, S>();
  for (const satz of saetze) {
    const erster = jeSchluessel.get(satz.schluessel);
    const verdichtet =
      erster === undefined ? satz : (satzErgaenzen(erster, satz, herkunft) ?? erster);
    jeSchluessel.set(satz.schluessel, verdichtet);
  }
  return [...jeSchluessel.values()];
}
