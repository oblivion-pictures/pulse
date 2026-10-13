/**
 * Die Listenrechnung hinter dem Nachrichten-Store (`stores/messages.svelte.ts`):
 * was mit der Nachrichtenliste EINES Kanals geschieht, ohne dass dafür
 * Zustand nötig wäre. Der Store behält Zustand, Mengen-Buchhaltung und
 * Zähler; hier steht nur, wie aus einer Liste und einer Eingabe die nächste
 * Liste wird.
 *
 * Importfrei im Sinn der `pnpm test:unit`-Falle (s. CLAUDE.md): nur der
 * Snowflake-Vergleich (`utils/snowflake.ts`, hängt selbst nur an
 * `snowflakeZeit.ts`), die Identitätsregel (`verlauf/nachrichtIdentitaet.ts`,
 * ohne Importe) und die Grabstein-Buchhaltung (`./grabsteine.ts`), alle per
 * Relativpfad MIT Endung, und ein reiner Typ-Import, den Node beim Laden
 * verwirft. Keine Rune — der Store ist eine `.svelte.ts`,
 * dieses Modul bewusst nicht.
 *
 * **Die Id-Mengen werden an Ort und Stelle fortgeschrieben.** `vorneAnfuegen`,
 * `einfuegen` und `entfernen` ändern die ihnen übergebenen Mengen `ids` /
 * `krypto` (so, wie der Store sie schon immer führte) und geben die neue Liste
 * zurück; der Store schreibt Liste und Mengen anschließend in seine
 * `$state`-Felder. Die Grabsteine (`begraben`, s. `grabsteine.ts`) schreibt nur
 * `entfernen` fort; die beiden anderen lesen sie und legen sie nach einem
 * Kappen in `krypto` zurück.
 */
import type { Message } from '../api/types';
import { compareSnowflakeId } from '../utils/snowflake.ts';
import { istBekannteNachricht, kanonischeNachrichtId } from '../verlauf/nachrichtIdentitaet.ts';
import { grabsteinSetzen } from './grabsteine.ts';

/** Die `krypto_id`s einer Liste samt den Grabsteinen des Kanals — der
 *  Ausgangsstand für einen Kanal, der noch keine Menge führt. */
export function kryptoIdsVon(list: Message[], begraben: Iterable<string> = []): Set<string> {
  const krypto = new Set(list.flatMap((m) => (m.krypto_id ? [m.krypto_id] : [])));
  for (const id of begraben) krypto.add(id);
  return krypto;
}

/** Die Liste ohne Nachrichten, deren kanonische Id ein Grabstein ist (`begraben`,
 *  s. `grabsteine.ts`) — eine frisch geladene Liste (`setInitial`) darf eine
 *  gelöschte Nachricht nicht wieder einschleppen, auch nicht als Kopie unter
 *  anderer lokaler Id. Ohne Treffer kommt dieselbe Liste zurück. */
export function ohneGrabsteine(list: Message[], begraben: ReadonlySet<string>): Message[] {
  if (begraben.size === 0) return list;
  const rest = list.filter((m) => !begraben.has(kanonischeNachrichtId(m.id, m.krypto_id)));
  return rest.length === list.length ? list : rest;
}

/** Nimmt `m` in die beiden Dublettenmengen auf. */
function merken(ids: Set<string>, krypto: Set<string>, m: Message): void {
  ids.add(m.id);
  if (m.krypto_id) krypto.add(m.krypto_id);
}

/** Gleicht beide Dublettenmengen mit der Liste ab, wenn diese gekappt wurde
 *  (`verworfen` ist nicht leer) oder `ids` mehr Einträge führt, als die Liste
 *  hält: danach stehen in `ids` und `krypto` nur noch Nachrichten, die wirklich
 *  in der Liste sind — nur das macht die Dublettenprüfung ehrlich (eine
 *  weggekappte Nachricht darf nach dem Hochscrollen wieder aufgenommen werden).
 *  Beide Mengen gehen stets zusammen, damit sie nicht auseinanderlaufen. Ändert
 *  die übergebenen Mengen an Ort und Stelle.
 *  **Ausgenommen sind die Grabsteine** (`begraben`, s. `grabsteine.ts`): die
 *  `krypto_id` einer gelöschten Nachricht steht nie in der Liste und überlebt
 *  den Neuaufbau, sonst erschiene eine später eintreffende Kopie derselben
 *  Nachricht unter anderer Id wieder. Sie werden nach dem Neuaufbau in `krypto`
 *  zurückgelegt. */
function mengenAbgleichen(
  ids: Set<string>,
  krypto: Set<string>,
  liste: Message[],
  verworfen: Message[],
  begraben: ReadonlySet<string>
): void {
  if (verworfen.length === 0 && ids.size <= liste.length) return;
  ids.clear();
  krypto.clear();
  for (const m of liste) merken(ids, krypto, m);
  for (const grabstein of begraben) krypto.add(grabstein);
}

/** Kappt eine id-sortierte Liste auf die neuesten `cap` Einträge. `verworfen`
 *  sind die ältesten, die dabei wegfallen — der Aufrufer braucht sie, um deren
 *  bestätigte Nonces zu vergessen. Ist nichts zu kappen, kommt dieselbe Liste
 *  zurück. */
export function kappen(
  list: Message[],
  cap: number
): { liste: Message[]; verworfen: Message[] } {
  if (list.length <= cap) return { liste: list, verworfen: [] };
  return { liste: list.slice(-cap), verworfen: list.slice(0, list.length - cap) };
}

/** Hängt `msg` id-geordnet an: ist sie jünger als die letzte, genügt ein
 *  Anhängen, sonst wird neu sortiert. Prüft keine Duplikate. */
export function einsortieren(list: Message[], msg: Message): Message[] {
  if (list.length === 0 || compareSnowflakeId(list[list.length - 1].id, msg.id) < 0) {
    return [...list, msg];
  }
  return [...list, msg].sort((a, b) => compareSnowflakeId(a.id, b.id));
}

/** Ersetzt die Nachricht mit `id` durch das, was `aendern` aus ihr macht.
 *  `null` heißt „nichts zu tun": die Nachricht ist nicht in der Liste, oder
 *  `aendern` hat selbst `null` geliefert. Sonst die neue Liste (Kopie). */
export function ersetzeNachricht(
  list: Message[],
  id: string,
  aendern: (alt: Message) => Message | null
): Message[] | null {
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const neu = aendern(list[idx]);
  if (!neu) return null;
  const next = list.slice();
  next[idx] = neu;
  return next;
}

/** Die neueste Id, die als Cursor für `?after=<id>` taugt, sonst `null`.
 *
 *  **Ids, die nicht in den BIGINT passen, zählen nicht.** Verschluesselte
 *  Nachrichten muenzen ihre Id lokal (`krypto/lokaleNachrichtId.ts`: seit
 *  2026-09-02 19 Ziffern, davor 20) und existieren serverseitig nicht — als
 *  `after` überläuft eine 20-stellige Id den BIGINT der Server-Abfrage mit 500
 *  (aufgefallen 2026-08-31 über die Sicherungs-Wiederherstellung, die genau
 *  solche Nachrichten in den Verlauf lädt). Der Cursor ist deshalb die
 *  neueste Id, die als BIGINT passt; vorläufige `tmp-`-Kopien zählen ohnehin
 *  nicht. */
export function letzteServerId(list: Message[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const id = list[i].id;
    if (id.startsWith('tmp-')) continue;
    if (id.length > 19 || (id.length === 19 && id > '9223372036854775807')) continue;
    return id;
  }
  return null;
}

/** Ergebnis von `lueckeZusammenfuehren`: die Liste nach dem Zusammenführen
 *  (id-sortiert, auf `cap` gekappt), die dabei weggefallenen ältesten
 *  Nachrichten und die Nonces, die dabei bestätigt wurden. */
export type Lueckenstand = {
  liste: Message[];
  verworfen: Message[];
  bestaetigteNonces: string[];
};

/** Führt eine Lücken-Seite (Nachrichten strikt neuer als `letzteServerId`)
 *  zerstörungsfrei in die Liste ein. `haveIds` sind die schon bekannten Ids —
 *  was der WS während des Hin und Her selbst geliefert hat, fällt dort durch.
 *
 *  Trägt eine eingehende Zeile die Nonce einer `tmp-`-Kopie, die wir noch
 *  halten, IST sie deren persistierte Fassung (das WS-Echo ging verloren, z. B.
 *  an einen Reconnect im Sendefenster): die `tmp-`-Kopie wird an Ort und
 *  Stelle ersetzt, statt die echte Zeile zu verwerfen — sonst bliebe die
 *  Nachricht für immer auf einer `tmp-`-Id hängen (nicht editierbar, nicht
 *  reagierbar bis zu einem vollen Neuladen des Kanals). `null`, wenn nichts zu
 *  tun ist. */
export function lueckeZusammenfuehren(
  list: Message[],
  haveIds: Set<string>,
  msgs: Message[],
  cap: number
): Lueckenstand | null {
  // nonce → Index einer optimistischen Kopie, die noch auf ihr Echo wartet.
  const tmpByNonce = new Map<string, number>();
  list.forEach((m, i) => {
    if (m.nonce && m.id.startsWith('tmp-')) tmpByNonce.set(m.nonce, i);
  });
  const next = list.slice();
  const append: Message[] = [];
  const bestaetigteNonces: string[] = [];
  let mutated = false;
  for (const m of msgs) {
    if (haveIds.has(m.id)) continue;
    const tmpIdx = m.nonce ? tmpByNonce.get(m.nonce) : undefined;
    if (tmpIdx !== undefined) {
      next[tmpIdx] = m;
      mutated = true;
      if (m.nonce && !m.id.startsWith('tmp-')) bestaetigteNonces.push(m.nonce);
    } else {
      append.push(m);
    }
  }
  if (!mutated && !append.length) return null;
  const sortiert = [...next, ...append].sort((a, b) => compareSnowflakeId(a.id, b.id));
  return { ...kappen(sortiert, cap), bestaetigteNonces };
}

/** Ergebnis von `vorneAnfuegen`: die neue Liste (gekappt), was tatsächlich neu
 *  dazukam (`neu`) und was am alten Ende weggefallen ist. */
export type Anfuegung = { liste: Message[]; neu: Message[]; verworfen: Message[] };

/** Fügt ältere Historie (Infinite-Scroll-Up) vor die Liste: `msgs` sind älter
 *  als der aktuelle älteste Eintrag. Was `ids` oder `krypto` schon kennen,
 *  fällt weg — die kanonische Id (`verlauf/nachrichtIdentitaet.ts`) blockt die
 *  Kopie desselben Worts aus der Archiv-Kette des anderen Geräts, die eine
 *  fremde lokale Id trägt und sonst doppelt angezeigt würde (Frischgerät +
 *  Sicherung, 2026-09-17). Der Rest wird id-sortiert vorangestellt und auf
 *  `cap` gekappt. Schreibt `ids` / `krypto` fort und gleicht sie mit der
 *  Liste ab, sobald gekappt wurde (die Grabsteine `begraben` bleiben dabei
 *  stehen). `null`, wenn nichts Neues dabei war. */
export function vorneAnfuegen(
  list: Message[],
  ids: Set<string>,
  krypto: Set<string>,
  msgs: Message[],
  cap: number,
  begraben: ReadonlySet<string>
): Anfuegung | null {
  const neu = [...msgs]
    .sort((a, b) => compareSnowflakeId(a.id, b.id))
    .filter((m) => !istBekannteNachricht(m.id, m.krypto_id, ids, krypto));
  if (!neu.length) return null;
  const { liste, verworfen } = kappen([...neu, ...list], cap);
  for (const m of neu) merken(ids, krypto, m);
  mengenAbgleichen(ids, krypto, liste, verworfen, begraben);
  return { liste, neu, verworfen };
}

/** Nimmt eine einzelne Nachricht in die Liste auf (id-geordnet, gekappt auf
 *  `cap`), sofern sie nicht schon bekannt ist — über die Id UND die kanonische
 *  Id, derselbe Schutz wie in `vorneAnfuegen`, auch in der Gegenrichtung: kam
 *  die Kopie aus Sicherung/Archiv ZUERST (kanonische Id als `id`), darf die
 *  live zugestellte (zustellungs-eigene Id, kanonische in `krypto_id`) sie
 *  nicht verdoppeln. Vorfall 2026-10-05: ohne das erschien jede Nachricht
 *  doppelt, deren Archivabholung vor der Live-Zustellung fertig war. Schreibt
 *  `ids` / `krypto` fort und gleicht BEIDE mit der Liste ab, sobald gekappt
 *  wurde (die Grabsteine `begraben` bleiben dabei stehen). `null` bei einem
 *  Duplikat. */
export function einfuegen(
  list: Message[],
  ids: Set<string>,
  krypto: Set<string>,
  msg: Message,
  cap: number,
  begraben: ReadonlySet<string>
): { liste: Message[]; verworfen: Message[] } | null {
  if (istBekannteNachricht(msg.id, msg.krypto_id, ids, krypto)) return null;
  const { liste, verworfen } = kappen(einsortieren(list, msg), cap);
  // Die Mengen bekommen die neue Nachricht auch dann, wenn das Kappen sie
  // gleich wieder aus der Liste wirft (sie war die älteste); der Abgleich
  // nimmt sie dann wieder heraus.
  merken(ids, krypto, msg);
  mengenAbgleichen(ids, krypto, liste, verworfen, begraben);
  return { liste, verworfen };
}

/** Nimmt die Nachricht mit `id` aus der Liste (hartes Löschen) und gibt die
 *  neue Liste zurück, `null`, wenn sie nicht in der Liste steht. Streicht die
 *  Id aus `ids`; eine vorhandene `krypto_id` bleibt als Grabstein in `krypto`
 *  stehen UND wird in `begraben` vermerkt (Begründung und Grenze in
 *  `grabsteine.ts`) — eine spätere Kopie derselben Nachricht unter anderer Id
 *  gilt damit als bekannt, auch nachdem ein Kappen `krypto` neu aufgebaut hat. */
export function entfernen(
  list: Message[],
  ids: Set<string>,
  krypto: Set<string>,
  begraben: Set<string>,
  id: string
): Message[] | null {
  const weg = list.find((m) => m.id === id);
  if (!weg) return null;
  ids.delete(id);
  if (weg.krypto_id) grabsteinSetzen(krypto, begraben, weg.krypto_id);
  return list.filter((m) => m.id !== id);
}
