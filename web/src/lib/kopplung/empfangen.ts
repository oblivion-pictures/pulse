/**
 * Die Empfangsseite des Verlaufsumzugs — das NEUE Geraet (Etappe F, E2E-DM).
 *
 * Ablauf: Code eintippen (oder scannen) → einloesen → eigene Schluessel
 * veroeffentlichen → warten, bis die Gesamtzahl steht → Stuecke holen,
 * entschluesseln, ablegen → abschliessen.
 *
 * **Das Veroeffentlichen der eigenen Schluessel gehoert in die Einloesung,
 * nicht daneben.** Die Spec (§6) nennt beides als das, was bei der Kopplung
 * passiert; getrennt gerufen waere „gekoppelt, aber nicht erreichbar" ein
 * moeglicher Zwischenzustand, und er sieht von aussen wie ein fertiger
 * Vorgang aus.
 *
 * **Warum das Ablegen keinen Zwischenstand braucht.**
 * `verlaufSaetzeErgaenzen` ist wiederholbar — ein zweimal geholtes und
 * zweimal abgelegtes Stueck ergibt denselben Bestand wie ein einmal
 * abgelegtes (derselbe Satz ergänzt sich selbst um nichts). Der Empfaenger
 * darf deshalb nach einem Abriss schlicht von vorne holen; er muss sich nicht
 * merken, wie weit er kam. Die Grabsteine sammelt der neue Lauf dabei wieder
 * ein, der Abgleich am Ende sieht sie also auch nach einem Abriss.
 * Teuer ist daran nur die Leitung, und die Alternative — ein eigener
 * Fortschritts-Speicher im Klienten — waere eine zweite Wahrheit neben dem
 * lokalen Verlauf.
 *
 * **Ergänzen, nicht überschreiben** (Gegenprüfung 2026-10-12, Fund 7). Bis
 * dahin legte die Kopplung jeden Satz blind über den Schlüssel
 * (`verlaufPutSaetze`): ein hier gelöschter Satz stand wieder da, wenn sein
 * Grabstein nicht über das Register lief (ein Sicherungs-Stein ohne Autor),
 * und eine Bearbeitung oder Reaktion, die seit der Einlösung auf diesem Gerät
 * ankam, fiel zurück auf den Stand des alten. Jetzt läuft das Ablegen über
 * `verlaufSaetzeErgaenzen` mit der Herkunft `kopplung` — eigene Wahrheit wie
 * die Sicherung (`verlauf/satz.ts::Nachschub`) — und durch das
 * Grabstein-Register. Liegt unter einem Schlüssel schon ein Satz eines
 * anderen Autors, bleibt er, und der übernommene fällt weg, wird aber als
 * übernommen gezählt (Gegenprüfung 2026-10-12, Fund 3, offen: Kopf von
 * `archiv/zeile.ts`).
 *
 * **Grabsteine des alten Geräts gelten hier weiter.** Nach dem letzten Stück
 * trägt `verlaufRegisterAbgleichen` genau die übernommenen Grabsteine ins
 * Register ein und markiert jede andere lokale Kopie derselben Nachricht
 * (Archiv-Kopie unter K, Grabstein unter D). Nur diese: ein Grabstein, der
 * hier schon lag, bleibt, was er war — ohne Autor löst er keine Identität auf.
 * Das Register des alten Geräts reist nicht mit, nur seine Grabstein-Sätze.
 */
import { serversStore } from '../api/servers.svelte';
import { kopplungApi } from '../api/kopplung';
import { geraeteKennung } from '../krypto/geraeteKennung';
import { veroeffentlicheSchluessel } from '../krypto/veroeffentlichen';
import { verlaufSaetzeErgaenzen, verlaufRegisterAbgleichen } from '../verlauf/db';
import { ausUmzug } from '../verlauf/herkunft';
import { aktuellesKonto } from '../verlauf/konto';
import type { Satz } from '../verlauf/schema';
import { codeNormalisieren } from './code';
import { einloesFehlerAus } from './einloesFehler';
import type { EinloesFehler } from './einloesFehler';
import { codeHash, stueckEntschluesseln, transportSchluessel } from './transport';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

const DEC = new TextDecoder();

/** Die Oberflaeche uebersetzt den Grund in Text (`messages/{de,en}.json`);
 *  hier steht deshalb keine Nutzersprache. Die Zuordnung selbst liegt
 *  importfrei in `einloesFehler.ts` und ist dort geprueft. */
export class EinloesenFehlgeschlagen extends Error {
  constructor(readonly grund: EinloesFehler) {
    super(`Kopplung fehlgeschlagen: ${grund}`);
  }
}

/**
 * Loest einen eingetippten oder gescannten Code ein.
 *
 * Die Normalisierung laeuft VOR dem Serveraufruf: eine Eingabe, die gar kein
 * Code sein kann, verbraucht sonst eine Rate-Chance und sieht fuer den
 * Nutzer aus wie ein abgelaufener Code (s. `code.ts::codeNormalisieren`).
 */
export async function kopplungEinloesen(
  eingabe: string
): Promise<{ kopplungId: string; code: string; altGeraet: string }> {
  const code = codeNormalisieren(eingabe);
  if (code === null) throw new EinloesenFehlgeschlagen('code_ungueltig');

  const hash = await codeHash(code);
  // VOR dem `try`, und das ist keine Formsache: der `catch` unten uebersetzt
  // jeden Fehler in einen `EinloesFehler`, also in eine Aussage ueber den
  // CODE. Ein Fehlschlag beim Ermitteln der eigenen Kennung ist keine — er
  // soll roh durchfallen, statt dem Nutzer einen abgelaufenen Code zu melden.
  const geraet = await geraeteKennung();
  let antwort;
  try {
    antwort = await kopplungApi.einloesen(
      { device_pubkey: geraet, code_hash: hash },
      cloudRoute()
    );
  } catch (fehler) {
    throw new EinloesenFehlgeschlagen(einloesFehlerAus(fehler));
  }

  // Der zweite Teil dessen, was eine Kopplung ausmacht (Spec §6): ab jetzt
  // ist dieses Geraet im Verzeichnis und kann adressiert werden.
  await veroeffentlicheSchluessel();

  return { kopplungId: antwort.id, code, altGeraet: antwort.alt_device_pubkey };
}

/** Was die Oberflaeche vom Empfaenger wissen will. */
type EmpfangsStand = {
  /** `null`, solange das alte Geraet die Gesamtzahl nicht gemeldet hat. */
  gesamt: number | null;
  geholt: number;
};

/** Fragt, ob der Sender fertig ist und wie weit er kam. */
export async function umzugStand(kopplungId: string): Promise<EmpfangsStand> {
  const stand = await kopplungApi.stand(
    { device_pubkey: await geraeteKennung(), kopplung_id: kopplungId },
    cloudRoute()
  );
  return { gesamt: stand.gesamt_stuecke, geholt: stand.vorhandene_stuecke.length };
}

/**
 * Verwirft eine laufende Einloesung — Befund 3 des Bughunts (2026-08-29):
 * ohne diesen Weg haengt der Empfaenger auf einer toten Kennung fest, wenn
 * das alte Geraet vor der Uebernahme abbricht, und der einzige Ausweg war
 * ein Neuladen der Seite. `POST /kopplung/abschliessen` ist von BEIDEN
 * Rollen aufrufbar (`routes/kopplung_umzug.py`) — dieselbe Route wie
 * `senden.ts::kopplungAbbrechen`, hier nur mit der Rolle des NEUEN Geraets.
 */
export async function kopplungVerwerfen(kopplungId: string): Promise<void> {
  await kopplungApi.abschliessen(
    { device_pubkey: await geraeteKennung(), kopplung_id: kopplungId },
    cloudRoute()
  );
}

/** Ein Stueck, wie der Sender es geschnuert hat (`senden.ts::stueckBytes`). */
type StueckInhalt = { saetze: Satz[] };

/**
 * Legt die Sätze EINES Stücks ab (`verlauf/herkunft.ts::ausUmzug`, dann
 * Ergänzen mit der Herkunft `kopplung`, s. Modulkopf). Ergebnis: wie viele
 * Sätze übernommen wurden (`ausUmzug` verwirft Sätze ohne gültige Kennung und
 * Ungeprüftes) und die übernommenen Grabsteine — der Abgleich nach dem
 * letzten Stück braucht genau diese (`verlaufRegisterAbgleichen`).
 */
export async function stueckAblegen(
  saetze: Satz[],
  kontoId: string
): Promise<{ anzahl: number; grabsteine: Satz[] }> {
  const uebernommen = ausUmzug(saetze, kontoId);
  await verlaufSaetzeErgaenzen(uebernommen, kontoId, 'kopplung');
  return {
    anzahl: uebernommen.length,
    grabsteine: uebernommen.filter((satz) => satz.geloescht)
  };
}

/**
 * Holt alle Stuecke und legt sie im lokalen Verlauf ab.
 *
 * Gibt die Zahl der uebernommenen Saetze zurueck — das ist die Zahl, die dem
 * Nutzer gezeigt wird, zusammen mit dem Hinweis, dass Bilder und Dateien auf
 * dem alten Geraet bleiben (Begruendung im Kopf von
 * `routes/kopplung_umzug.py`).
 *
 * Wirft, wenn die Gesamtzahl noch nicht steht: ein Umzug ohne sie ist nicht
 * als vollstaendig erkennbar, und ein halber Verlauf, den niemand als halb
 * ausweist, ist schlimmer als gar keiner.
 */
export async function verlaufUebernehmen(
  kopplungId: string,
  code: string,
  melde: (geholt: number, gesamt: number) => void
): Promise<{ saetze: number }> {
  const { gesamt } = await umzugStand(kopplungId);
  if (gesamt === null) throw new Error('Das alte Geraet hat den Umzug noch nicht abgeschlossen');

  // Befund 1 (2026-08-29): das EIGENE Konto dieses Geraets stempeln, nicht
  // blind uebernehmen, was das Stueck traegt (`verlauf/herkunft.ts::ausUmzug`).
  // Eine Kopplung ist per Ablauf (Code + `veroeffentlicheSchluessel()` oben)
  // immer Umzug DESSELBEN Kontos — der Stempel ist trotzdem die Quelle der
  // Wahrheit auf DIESEM Geraet, nicht das alte:
  // `verlauf/kontoFilter.ts::gehoertZuKonto` liest spaeter nur noch das hier
  // gesetzte Feld.
  const kontoId = aktuellesKonto();
  if (kontoId === null) throw new Error('kein angemeldetes Konto');

  const schluessel = await transportSchluessel(code, kopplungId);
  let uebernommen = 0;
  const grabsteine: Satz[] = [];
  melde(0, gesamt);

  for (let folge = 0; folge < gesamt; folge++) {
    const stueck = await kopplungApi.stueckHolen(
      { device_pubkey: await geraeteKennung(), kopplung_id: kopplungId, folge },
      cloudRoute()
    );
    const klartext = await stueckEntschluesseln(schluessel, kopplungId, folge, stueck.daten);
    const inhalt = JSON.parse(DEC.decode(klartext)) as StueckInhalt;
    const abgelegt = await stueckAblegen(inhalt.saetze, kontoId);
    grabsteine.push(...abgelegt.grabsteine);
    uebernommen += abgelegt.anzahl;
    melde(folge + 1, gesamt);
  }
  await verlaufRegisterAbgleichen(kontoId, grabsteine);

  // Erst NACH dem letzten erfolgreichen Ablegen aufraeumen. Umgekehrt waere
  // ein Fehler im letzten Stueck ein endgueltiger Verlust — der Server haelt
  // keine zweite Kopie, und der Sender muesste den ganzen Umzug wiederholen.
  await kopplungApi.abschliessen(
    { device_pubkey: await geraeteKennung(), kopplung_id: kopplungId },
    cloudRoute()
  );

  return { saetze: uebernommen };
}
