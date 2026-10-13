/**
 * Bearbeitungs-Zeilen aus dem Server-Archiv auf lokale Sätze anwenden — die
 * reine Regel, importfrei, damit Nodes Testläufer sie prüft; der Datenbank-
 * Durchlauf steht in `dbArchivBearbeitung.ts`.
 *
 * **Wozu** (main-Prüfbericht, Fund 5). Eine Bearbeitung reist als Frame an
 * die Geräte, die es gerade gibt. Ein Frischgerät ohne Sicherung holte die
 * Nachricht aus dem Archiv und zeigte den Originaltext, denn die Archiv-
 * Zeile ist die Fassung beim Senden. Der Autor liefert deshalb zu jeder
 * Bearbeitung eine Bearbeitungs-Zeile ein (`archiv/zeile.ts`), wie zu jeder
 * Löschung eine Grabstein-Zeile.
 *
 * **Sie ergänzt nur.** Sie trifft nur Sätze ihres Autors (Einlieferer =
 * Autor, `archiv/zeile.ts::leseZeile`, dieselbe Bindung wie
 * `krypto/loeschZiel.ts::trifftFrame`) und nur solche, die noch UNBEARBEITET
 * sind. Einen bearbeiteten Satz hat auf diesem Gerät schon ein Frame, die
 * Sicherung oder die Kopplung erreicht; deren Zeit ist die des Empfangs, die
 * der Zeile die Uhr des Autors — ein Vergleich der beiden hielte nur bei
 * gleich gehenden Uhren. Unter mehreren Zeilen derselben Nachricht gilt die
 * jüngste (`z`, dieselbe Uhr).
 */

/** Eine angenommene Bearbeitungs-Zeile. */
export type ArchivBearbeitung = {
  autorId: string;
  kennung: string;
  inhalt: string;
  bearbeitetAm: string;
};

type SatzTeil = {
  nachrichtId: string;
  kryptoId: string | null;
  autorId: string;
  inhalt: string;
  bearbeitetAm: string | null;
  geloescht: boolean;
};

function schluessel(autorId: string, kennung: string): string {
  return `${autorId}|${kennung}`;
}

/** Nimmt `neu` in `bestand` auf (je Autor und Kennung die jüngste). */
export function bearbeitungenSammeln(
  bestand: Map<string, ArchivBearbeitung>,
  neu: Iterable<ArchivBearbeitung>
): void {
  for (const b of neu) {
    const k = schluessel(b.autorId, b.kennung);
    const liegt = bestand.get(k);
    if (liegt === undefined || liegt.bearbeitetAm < b.bearbeitetAm) bestand.set(k, b);
  }
}

/** Die neue Fassung von `satz`, wenn eine Zeile aus `bearbeitungen` ihn
 *  trifft und er noch unbearbeitet ist, sonst `null`. */
export function bearbeitungFuerSatz<S extends SatzTeil>(
  satz: S,
  bearbeitungen: Map<string, ArchivBearbeitung>
): S | null {
  if (satz.geloescht || satz.bearbeitetAm) return null;
  const treffer =
    bearbeitungen.get(schluessel(satz.autorId, satz.nachrichtId)) ??
    (satz.kryptoId ? bearbeitungen.get(schluessel(satz.autorId, satz.kryptoId)) : undefined);
  if (treffer === undefined) return null;
  return { ...satz, inhalt: treffer.inhalt, bearbeitetAm: treffer.bearbeitetAm };
}
