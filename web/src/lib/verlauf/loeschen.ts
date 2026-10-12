/**
 * Löschen im lokalen Verlauf, samt den Folgen einer Löschung (Anhang-Bytes,
 * Sicherungs-Stein). Aus `index.ts` herausgelöst (2026-10-12), als das
 * Grabstein-Register dazukam; `index.ts` reicht beide Einstiege durch. Wirft
 * nie nach außen — wie der Rest von `verlauf/index.ts` (s. dortigen
 * Modulkopf).
 *
 * Zwei Einstiege, je nachdem, woher der Autor kommt (`dbLoeschen.ts`):
 *
 *   - `verlaufNachrichtGeloescht`: ein liegender Satz unter seiner lokalen
 *     ID — die eigene Löschung, der Server-Abgleich, das Server-Ereignis.
 *   - `verlaufGebundenGeloescht`: Autor und Kennung stehen schon fest —
 *     Lösch-Frame (`krypto/empfangen.ts`), Grabstein-Zeile im Archiv
 *     (`archiv/lesen.ts`).
 *
 * Beide tragen die Löschung ins Grabstein-Register ein
 * (`grabsteinRegister.ts`) und markieren JEDE lokale Kopie der Nachricht.
 */
import { sortierSchluessel } from './satz';
import type { Satz } from './schema';
import {
  anhangBytesLoeschen,
  satzAnhangIds,
  verlaufGebundenLoeschen,
  verlaufSatzLoeschen
} from './db';
import { aktuellesKonto } from './konto';
import { istLokalerKanal } from './kanalArt';
import { istGueltigeKennung } from './identitaet';
import { verlaufZustand } from './zustand.svelte';

/** Was der Sicherungs-Stein über die gelöschte Nachricht wissen muss. */
type SteinAngaben = { autorId: string; kryptoId: string | null; anhaenge?: unknown[] };

/** Der Lösch-Haken der Sicherung: die Löschung wandert als Grabstein-Frame
 *  in den Archiv-Ordner, damit das Archiv nicht stärker ist als die App.
 *  Feuert und vergisst wie der Spiegel-Haken in `index.ts`. */
function sicherungGrabstein(kanalId: string, nachrichtId: string, angaben: SteinAngaben): void {
  void import('$lib/sicherung/andock')
    .then(({ sicherungGrabstein }) => sicherungGrabstein(kanalId, nachrichtId, angaben))
    .catch(() => {
      /* die Sicherung darf den Verlaufsweg nie stören — s. andock.ts */
    });
}

/** Die Folgen einer Löschung je markiertem Satz: seine Anhang-Bytes aus dem
 *  Geräte-Cache (gelöscht heißt gelöscht) und ein Stein in der Sicherung —
 *  mit Autor und Kennung des Satzes, und erst NACH dem gelungenen Markieren:
 *  ein Stein in der Sicherung lässt sich nicht zurücknehmen. */
function folgen(kanalId: string, markiert: Satz[]): void {
  for (const satz of markiert) {
    for (const id of satzAnhangIds(satz)) void anhangBytesLoeschen(id).catch(() => {});
    sicherungGrabstein(kanalId, satz.nachrichtId, satz);
  }
}

/**
 * Setzt den Grabstein für die Nachricht unter `nachrichtId` — und für jede
 * andere lokale Kopie derselben Nachricht (`dbLoeschen.ts::verlaufSatzLoeschen`).
 * `message_delete` trägt am WS keine volle Nachricht (nur `channel_id`+`id`)
 * — deshalb kein Umweg über `zuSatz`, sondern direkt über den Schlüssel.
 *
 * `nurKlartext`: für Wege, die nur über Klartext entscheiden dürfen
 * (Server-Ereignisse, Server-Abgleich) — ein verschlüsselter Satz bleibt
 * dann unangetastet, und es entsteht auch kein Sicherungs-Stein.
 */
export function verlaufNachrichtGeloescht(
  kanalId: string,
  nachrichtId: string,
  opts: { nurKlartext?: boolean } = {}
): void {
  if (!istLokalerKanal(kanalId)) return;
  const kontoId = aktuellesKonto();
  if (kontoId === null) return;
  void verlaufSatzLoeschen(sortierSchluessel(kanalId, nachrichtId), kontoId, opts.nurKlartext === true)
    .then((markiert) => folgen(kanalId, markiert))
    .catch((err) => {
      verlaufZustand.melde(err);
    });
}

/**
 * Eine gebundene Löschung: der Autor `autorId` löscht seine Nachricht mit
 * der kanonischen Kennung `kennung` (`dbLoeschen.ts::verlaufGebundenLoeschen`).
 * Trifft nur Sätze dieses Autors, trägt die Löschung aber auch dann ins
 * Register ein, wenn hier (noch) keiner liegt — und schreibt dann einen
 * Sicherungs-Stein mit Autor und Kennung, damit auch eine Kopie in der
 * Sicherung gelöscht bleibt. Stand die Löschung schon im Register (Archiv
 * und Sicherung wenden ihre Grabsteine bei jedem Lesen erneut an), passiert
 * nichts weiter.
 *
 * Eine Kennung, die keine ist (`identitaet.ts::istGueltigeKennung`), löscht
 * nichts und schreibt nichts: ohne lokalen Treffer entstünde aus ihr ein Stein
 * in der Sicherung, und eine frei gewählte Kennung `"x"` brachte deren Leser
 * zum Absturz (Gegenprüfung 2026-10-12, Fund 1). Die Leser verwerfen sie
 * schon vorher; dies ist die Wand an der Stelle, die dauerhaft schreibt.
 *
 * Ergebnis: die lokalen IDs der markierten Sätze — der Aufrufer nimmt sie
 * aus der Anzeige. Leer bei jedem Fehlschlag (gemeldet bei `verlaufZustand`).
 */
export async function verlaufGebundenGeloescht(
  kanalId: string,
  kennung: string,
  autorId: string
): Promise<string[]> {
  if (!istLokalerKanal(kanalId) || !istGueltigeKennung(kennung)) return [];
  const kontoId = aktuellesKonto();
  if (kontoId === null) return [];
  try {
    const { markiert, neuEingetragen } = await verlaufGebundenLoeschen(
      kanalId,
      kontoId,
      autorId,
      [kennung]
    );
    if (markiert.length > 0) folgen(kanalId, markiert);
    else if (neuEingetragen) sicherungGrabstein(kanalId, kennung, { autorId, kryptoId: kennung });
    return markiert.map((satz) => satz.nachrichtId);
  } catch (err) {
    verlaufZustand.melde(err);
    return [];
  }
}
