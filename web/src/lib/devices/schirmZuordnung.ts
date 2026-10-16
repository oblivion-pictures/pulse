/**
 * Standplatz-Geräte — **welche Bildschirme es gibt und welcher Strom welchen
 * zeigt**.
 *
 * Aus `schirme.svelte.ts` ausgelagert (2026-10-16, Grössen-Regel: die Datei
 * stand nach der Weckfehler-Wacht knapp unter der harten Grenze). Hier steht
 * nur das Lesen — Bildschirmliste und Zuordnung Strom → Bildschirm —, dort
 * bleibt das Handeln (wecken, warten, Fenster öffnen, übernehmen). Inhalt
 * unverändert übernommen.
 */

import type { Device, DeviceMonitor } from '$lib/api/devices';
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { zuordneStroeme, type Zuordnungslage } from '$lib/stream/quellenummer';
import { schirmFuerFenster } from '$lib/stream/schirmFuerFenster';
import { m } from '$lib/paraglide/messages.js';

/** Ein Bildschirm samt der einen Angabe, die beide Oberflächen brauchen. */
export interface SchirmStand extends DeviceMonitor {
  /** Läuft er schon in einem Fenster? */
  open: boolean;
}

/** Alle Ströme des Besitzers in diesem Standplatz — von Hand gestartete wie
 *  geweckte. */
export function stroemeVon(device: Device) {
  return streamPresence
    .streamsIn(device.channel_id)
    .filter((s) => s.user_id === device.owner_user_id);
}

/** Ein einzelner Strom, wie `stroemeVon` ihn liefert. */
type Strom = ReturnType<typeof stroemeVon>[number];

/**
 * Die Bildschirme, die dieses Gerät hat.
 *
 * Meldet es keine (nie verbunden oder ältere Fassung), bleibt genau ein Eintrag
 * übrig: sein Hauptbildschirm. Das ist ehrlicher als eine erfundene Liste — und
 * der eine Knopf tut, was er immer getan hat.
 */
function monitorListe(device: Device): DeviceMonitor[] {
  if (device.monitors.length > 0) return device.monitors;
  return [{ index: 0, name: m.device_view_screen_primary(), primary: true }];
}

/**
 * Was die Zuordnung ausser Strömen und Bildschirmen noch wissen muss: ob
 * [`monitorListe`] gerade eine ECHTE Liste geliefert hat oder ihren einen
 * erfundenen Ersatz-Eintrag.
 *
 * **Warum das nach unten durchgereicht werden muss:** der Ersatz-Eintrag trägt
 * `index: 0`, eine echte Bildschirm-Nummer (ab 1) kann darauf nie passen. Die
 * Regel dort schliesst nummerierte Ströme sonst vom Notbehelf aus — mit gutem
 * Grund, aber eben nur gegen eine echte Liste. Gegen die erfundene fiel ein
 * Gerät heraus, dessen `refreshMonitors()` beim Anmelden einmal fehlschlug
 * (`anmeldung.svelte.ts` fängt still, es gibt kein Nachmelden): sein Strom trug
 * `monitor_index: 1`, passte auf nichts, galt nicht als namenlos — der
 * Ersatz-Schirm blieb „frei", und ein Klick darauf lief ins Leere.
 */
function lage(device: Device): Zuordnungslage {
  return { listeGemeldet: device.monitors.length > 0 };
}

/**
 * Welcher Strom zeigt welchen Bildschirm — die **eine** Zuordnung, an der beide
 * Fragen hängen: „läuft der schon?" und „welchen Strom mache ich auf, wenn
 * jemand zusehen will?".
 *
 * Beide getrennt zu beantworten hiesse, dass ein Bildschirm als laufend gilt,
 * dessen Strom sich nicht finden lässt — dann steht ein Knopf da, der wortlos
 * nichts tut. Genau diese Sorte Fehler soll hier verschwinden.
 *
 * **Die eigentliche Regel sitzt in `stream/quellenummer.ts::zuordneStroeme`** —
 * diese Funktion zieht nur die Store-Daten (`stroemeVon`, `monitorListe`,
 * `device.stream_slots`, [`lage`]) zusammen und ruft sie auf. So kann Nodes
 * eingebauter Testläufer die Regel prüfen, obwohl diese Datei selbst für ihn
 * unerreichbar ist (Stores).
 *
 * **Der Hauptbildschirm bekommt zusätzlich einen Strom des Geräts zugeordnet,
 * dessen Name zu keinem Schirm passt** (Bughunt 2026-08-17, Notbehelf in
 * `zuordneStroeme`). Der Grund steht in `wecken.ts::quelleFuerMonitor`: der
 * Haupt-Knopf („Übernehmen") schickt **keine** Nummer mit, das Gerät nimmt
 * dann die Quelle seines Standplatz-Profils — und das ist per Vorgabe sein
 * Hauptbildschirm. Trägt dieser erste Strom einen Namen, der nicht trifft
 * (Profil auf eine andere Quelle gestellt, Bildschirmliste seit dem Start
 * verändert, allgemeiner Ersatzname), galt der Hauptbildschirm als frei und
 * wurde erneut angeboten. Ein Klick darauf lief dann ins Nichts: das Gerät
 * erkennt die schon laufende Quelle und verwirft den Ruf (`wecken.ts`), es
 * ging kein zweites Fenster auf, und für den Steuernden sah es aus, als sei
 * der Player verschwunden.
 *
 * **Nur Ströme des Geräts zählen dafür** (`device.stream_slots`, dieselbe
 * Quelle wie in `darstellung.ts::stromGehoertGeraet`): was der Besitzer von
 * Hand überträgt — ein Fenster, eine Anwendung — sagt nichts über seine
 * Bildschirme. Meldet ein Gerät seine Plätze nicht (ältere Fassung), bleibt es
 * beim reinen Namensvergleich.
 *
 * **Annahme, die falsch sein kann:** dass ein namenlos zugeordneter Gerätestrom
 * der Hauptbildschirm ist. Steht im Profil ausdrücklich ein anderer Schirm, ist
 * er es nicht — dann fehlt der Hauptbildschirm in der Auswahl, obwohl er zu
 * holen wäre. Das ist die harmlosere Hälfte: ein Eintrag zu wenig fällt auf,
 * ein Eintrag, der wortlos nichts tut, fällt nicht auf. Für die andere Hälfte
 * — dass dieser Eintrag NICHT sicher ist — s.
 * `quellenummer.ts::zuordnungIstEindeutig`, an der [`schirmeVonFuerFenster`]
 * über `schirmFuerFenster` hängt.
 */
function zuordnung(device: Device): Map<number, Strom> {
  const geraetePlaetze = new Set(device.stream_slots ?? []);
  return zuordneStroeme(stroemeVon(device), monitorListe(device), geraetePlaetze, lage(device))
    .karte;
}

/** Die Bildschirme eines Geräts, jeder mit „läuft schon". */
export function schirmeVon(device: Device): SchirmStand[] {
  const karte = zuordnung(device);
  return monitorListe(device).map((mon) => ({ ...mon, open: karte.has(mon.index) }));
}

/** Ein Bildschirm aus Sicht EINES bestimmten Player-Fensters — zusätzlich
 *  markiert, ob er genau dieses Fenster ist. */
export interface SchirmStandFuerFenster extends SchirmStand {
  dieses_fenster: boolean;
}

/**
 * Die Bildschirmliste für GENAU EIN Fenster — anders als `schirmeVon` geht sie
 * nicht identisch an jedes Fenster desselben Geräts: `fensterSlot` ist der
 * Sende-Platz, den DIESES Fenster gerade zeigt, und nur der zugehörige
 * Bildschirm bekommt `dieses_fenster: true`.
 *
 * Reine Regel in `stream/schirmFuerFenster.ts` — auch hier fail-visible: ist
 * die Zuordnung nicht eindeutig, bleibt jeder Eintrag unmarkiert (Regel in
 * `quellenummer.ts::zuordnungIstEindeutig`).
 */
export function schirmeVonFuerFenster(device: Device, fensterSlot: number): SchirmStandFuerFenster[] {
  const geraetePlaetze = new Set(device.stream_slots ?? []);
  const gemeint = schirmFuerFenster(
    stroemeVon(device),
    monitorListe(device),
    geraetePlaetze,
    fensterSlot,
    lage(device),
  );
  return schirmeVon(device).map((s) => ({ ...s, dieses_fenster: s.index === gemeint }));
}

/** Der laufende Strom eines Bildschirms, oder `undefined`. */
export function stromFuer(device: Device, mon: DeviceMonitor) {
  return zuordnung(device).get(mon.index);
}
