/**
 * Die Wiedereinspiel-Entscheidung für Megolm-Gruppennachrichten (Bughunt
 * 2026-09-23) — importfrei, damit der Node-Testläufer sie ohne Bundler
 * prüft (CLAUDE.md „Die Falle“).
 *
 * **Der Angriff:** Megolm erlaubt das Entschlüsseln eines bereits gesehenen
 * Geheimtexts beliebig oft (`gruppe.rs::Gruppennachricht::zaehler` wird
 * herausgegeben, genau dafür). Der einzige Schutz war bislang
 * `verlaufSchonAbgelegt` über die vom SERVER vergebene Zustellungs-ID — ein
 * böswilliger Server legte denselben Geheimtext unter neuer ID erneut in
 * das Postfach und die Nachricht erschien (auch gelöschte wieder).
 *
 * **Die Regel:** je eingehender Sitzung wird der höchste sauber geöffnete
 * Zählerstand gemerkt (`gruppenSitzungen.ts`, neustartfest in IndexedDB).
 * Eine Nachricht mit Zähler ≤ Stand ist normalerweise ein Wiedereinspiel
 * und wird verworfen — AUSSER sie trägt dieselbe Zustellungs-ID wie der
 * Standeintrag: dann ist es die EIGENE Zustellung, die zwischen Ent-
 * schlüsseln und Ablegen nicht durchkam (sie blieb unquittiert liegen und
 * kommt beim nächsten Zyklus wieder). Sie zu verwerfen wäre
 * Nachrichtenverlust, sie erneut zu öffnen ist gefahrlos — schon abgelegt
 * ist sie zu dem Zeitpunkt nicht (`zustellungOeffnen` prüft das zuerst),
 * und ein echter Wiedereinspiel unter fremder, neuer ID scheitert an genau
 * diesem Vergleich. Seit 2026-10-21 schreibt erst die gelungene Ablage den
 * Stand fest (`wirksamerStand` unten); der Fall bleibt als Sicherung, falls
 * ein Satz nach dem Festschreiben wieder aus dem Verlauf verschwindet.
 *
 * **Bekannte Grenze (ponytail):** die Annahme „eine Sitzung sieht ihre
 * Nachrichten in Zählerreihenfolge“ beruht darauf, dass der Abholweg die
 * Postfach-Einträge aufsteigend nach Server-ID verarbeitet. Genau so kommt
 * sie vom Server; wer sie jemals ungeordnet verarbeitet, lässt diese
 * Entscheidung fallen und braucht eine „gesehene Zähler“-Menge statt des
 * Höchststands.
 */

export type Wasserstand = {
  zaehler: number;
  /** Die Zustellungs-ID, die diesen Stand erzeugt hat. */
  zustellung: string;
};

export type WasserstandEntscheidung =
  | 'ok' // noch nie gesehener Zählerstand — öffnen und Stand heben
  | 'eigene_wiederholung' // dieselbe Zustellung kommt erneut (Absturz-Fenster) — gefahrlos erneut öffnen
  | 'wiedereinspiel'; // älterer Stand unter NEUER Zustellungs-ID — Angriff, verwerfen

export function wasserstandEntscheidung(
  stand: Wasserstand | null,
  zaehler: number,
  zustellungId: string
): WasserstandEntscheidung {
  if (stand === null || zaehler > stand.zaehler) return 'ok';
  return zustellungId === stand.zustellung ? 'eigene_wiederholung' : 'wiedereinspiel';
}

/**
 * Der Stand, gegen den eine Nachricht geprueft wird: der gespeicherte oder
 * ein in DIESEM Abholzyklus vorgemerkter, wenn der hoeher ist (Push-Bughunt
 * 2026-10-21, Befund 2).
 *
 * **Warum vormerken statt sofort speichern:** bis dahin hob
 * `oeffneGruppennachricht` den gespeicherten Stand schon beim Entschluesseln,
 * vor der Ablage. Scheiterte die Ablage (Gruppe lokal noch unbekannt,
 * IndexedDB-Fehler), blieb die Zustellung unquittiert liegen — kam aber im
 * selben Zyklus eine spaetere Nachricht derselben Sitzung dazu, stand der
 * Wasserstand schon ueber ihr, und im naechsten Zyklus galt sie als
 * Wiedereinspiel: quittiert, nie abgelegt, verloren. Jetzt schreibt erst die
 * gelungene Ablage den Stand fest (`zyklusAuswerten.ts`, `festschreiben`).
 *
 * **Warum dann ueberhaupt vormerken:** ohne die Vormerkung waere ein
 * Wiedereinspiel unter neuer Zustellungs-ID IM SELBEN Zyklus durchgerutscht
 * (der gespeicherte Stand steht ja noch unter beiden Kopien). Die Vormerkung
 * lebt nur im Arbeitsspeicher eines Zyklus — Zyklen laufen nacheinander
 * (`postfachNachlauf.ts`, Konto-Sperre), keiner sieht die eines anderen.
 *
 * **Warum nicht stattdessen „Kanal vor dem Entschlüsseln prüfen":** das
 * deckte nur den unbekannten Kanal, nicht den IndexedDB-Fehler beim Ablegen,
 * und hielte die erste Nachricht einer gerade erst bekannt werdenden Gruppe
 * bis zum nächsten Abhol-Auslöser zurück, statt sie sofort anzuzeigen.
 *
 * **Was bleibt:** bricht der Zyklus genau zwischen Ablage und Festschreiben
 * ab, quittiert der nächste die Zustellung als `schonAbgelegt`, ohne den
 * Stand zu heben; ein Wiedereinspiel genau dieses Zählers unter neuer ID
 * würde dann nicht als solches erkannt, solange keine spätere Nachricht der
 * Sitzung den Stand darüber hebt.
 */
export function wirksamerStand(
  gespeichert: Wasserstand | null,
  vorgemerkt: Wasserstand | undefined
): Wasserstand | null {
  if (!vorgemerkt) return gespeichert;
  return gespeichert && gespeichert.zaehler >= vorgemerkt.zaehler ? gespeichert : vorgemerkt;
}

/** Die Vormerkungen eines Abholzyklus, je Kanal + Geraet + Sitzung
 *  (`vormerkSchluessel`) — `empfangen.ts` legt je Zyklus eine frische an. */
export type Vormerkungen = Map<string, Wasserstand>;

export function vormerkSchluessel(kanalId: string, geraet: string, sitzungId: string): string {
  return JSON.stringify([kanalId, geraet, sitzungId]);
}
