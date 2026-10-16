/**
 * Remote-Rechner — was DIESER Betrachter an einem Gerät darf, als reine Regel.
 *
 * **Seit 2026-10-16 entscheidet allein die Freigabeliste** (Eigentümer-
 * Entscheid, `docs/standplatz-geraete.md`, oberster Abschnitt): wecken und
 * steuern darf, wen eine nicht abgelaufene Zeile der Liste deckt und wer den
 * Standplatz-Kanal sieht. Das rechnet der Server je Betrachter aus und liefert
 * es als `Device.steuerbar` (`geraete_freigabe.py::steuerbar_je_geraet`); das
 * Recht `REMOTE_CONTROL` zählt dafür nicht mehr. Zusehen darf beim Strom eines
 * Geräts nur der Besitzer — immer — und sonst jeder mit Sicht auf den Kanal,
 * solange jemand steuert (`geraete_zuschauen.py`, sonst 403 an `/whep`).
 *
 * **Die Oberfläche zeigt das nur an, sie setzt es nicht durch.** Der Server
 * prüft bei jeder Handlung frisch. Hier steht die Regel einmal, damit die
 * Stellen, die ein Gerät zeigen (Kanalliste, Mitgliederliste, Teilnehmer-
 * Kachel, Aktivitätskopf, Player), nicht jede ihre eigene Fassung pflegen.
 *
 * **Eine Lücke, bewusst:** der Wecker darf serverseitig während seiner
 * Weckfrist zusehen (60 s, bis die Sitzung beginnt), diese Regel kennt ihn
 * nicht. Er braucht sie nicht — sein Fenster öffnet `schirme.svelte.ts`
 * selbst, sobald das Bild da ist, ohne LIVE-Abzeichen.
 *
 * Importfrei, damit Nodes Testläufer es direkt laden kann (`pnpm
 * test:unit`-Falle: keine Runen, keine erweiterungslosen Importe).
 */

export type GeraeteZustand = 'ready' | 'busy' | 'offline';

/** Was die Regel von einem Gerät braucht — eine Teilmenge von `Device`. */
export interface GeraetSicht {
  state: GeraeteZustand;
  owner_user_id: string;
  /** Vom Server je Betrachter; fehlt es (älterer Server, frisch gemeldetes
   *  Gerät), gilt es als `false` — fail-closed in der Anzeige. */
  steuerbar?: boolean;
  /** Plätze, auf denen das Gerät gerade sendet. */
  stream_slots?: number[];
}

/**
 * Der Zustandspunkt. `online` ist der neutrale Punkt für ein waches Gerät,
 * das DIESER Betrachter nicht steuern darf — Grün hiesse „kannst du
 * übernehmen", und das stimmt für ihn nicht.
 */
export type Punkt = 'bereit' | 'online' | 'belegt' | 'offline';

export interface ZeilenZustand {
  /** Führt ein Klick in die Geräteansicht? Sonst ist die Zeile gesperrt. */
  klickbar: boolean;
  punkt: Punkt;
  /** LIVE-Abzeichen zeigen? */
  live: boolean;
}

/** Gehört das Gerät dem Betrachter? `ich` ist die Kennung auf DIESEM Server. */
export function istBesitzer(d: GeraetSicht, ich: string | null | undefined): boolean {
  return !!ich && d.owner_user_id === ich;
}

/**
 * Darf der Betrachter dieses Gerät wecken und steuern?
 *
 * Der Besitzer nie (er kann sein eigenes Konto nicht fernsteuern; der Server
 * liefert für ihn ohnehin `false`, die Prüfung hier hält das auch gegen einen
 * fehlerhaften Rahmen).
 */
export function darfGeraetSteuern(d: GeraetSicht, ich: string | null | undefined): boolean {
  return !istBesitzer(d, ich) && d.steuerbar === true;
}

/**
 * Darf der Betrachter dem Strom dieses Geräts zusehen?
 *
 * Besitzer immer (Entscheid 4), alle anderen nur, solange jemand steuert —
 * ein bloss geweckter Rechner zeigt seinen unbewachten Desktop niemandem.
 */
export function darfGeraetZusehen(d: GeraetSicht, ich: string | null | undefined): boolean {
  return istBesitzer(d, ich) || d.state === 'busy';
}

/**
 * Wie die Zeile eines Geräts aussieht — Kanalliste und Mitgliederliste.
 *
 * `sendet`: überträgt das Gerät gerade in seinem Kanal
 * (`darstellung.ts::geraetSendet`).
 */
export function zeilenZustand(
  d: GeraetSicht,
  ich: string | null | undefined,
  sendet: boolean,
): ZeilenZustand {
  const besitzer = istBesitzer(d, ich);
  const steuern = darfGeraetSteuern(d, ich);
  let punkt: Punkt;
  if (d.state === 'offline') punkt = 'offline';
  else if (d.state === 'busy') punkt = 'belegt';
  else punkt = besitzer || steuern ? 'bereit' : 'online';
  return {
    // Der Besitzer kommt immer hinein: er zieht die Zeile um, sieht seinen
    // Rechner an und findet dort, dass er ihn nicht selbst übernehmen kann.
    klickbar: besitzer || steuern,
    punkt,
    live: sendet && darfGeraetZusehen(d, ich),
  };
}

/**
 * Die Plätze eines Besitzers in einem Kanal, die DIESER Betrachter nicht
 * öffnen soll: die Plätze seiner Geräte, denen er gerade nicht zusehen darf.
 *
 * `geraete` sind die Geräte genau dieses Besitzers in genau diesem Kanal
 * (`deviceStore.alleImKanal`). Was der Besitzer selbst überträgt, steht in
 * keinem `stream_slots` und bleibt damit offen.
 */
export function verborgenePlaetze(
  geraete: readonly GeraetSicht[],
  ich: string | null | undefined,
): Set<number> {
  const raus = new Set<number>();
  for (const d of geraete) {
    if (darfGeraetZusehen(d, ich)) continue;
    for (const slot of d.stream_slots ?? []) raus.add(slot);
  }
  return raus;
}

/** Ströme ohne die verborgenen Plätze. */
export function ohneVerborgene<T extends { slot: number }>(
  stroeme: readonly T[],
  verborgen: ReadonlySet<number>,
): T[] {
  return stroeme.filter((s) => !verborgen.has(s.slot));
}

/**
 * Kommt der Strom auf `slot` von einem dieser Geräte?
 *
 * Meldet ein Gerät seine Plätze nicht (ältere Fassung), ist die Antwort
 * `false` — der Strom gilt dann als der eines Menschen. Der Server erkennt
 * Geräteströme zusätzlich am Merkmal des Stream-Tokens; dort ist das kein
 * Schlupfloch, hier kostet es höchstens einen Knopf, der beim Klick scheitert.
 */
export function istGeraetestrom(geraete: readonly GeraetSicht[], slot: number): boolean {
  return geraete.some((d) => (d.stream_slots ?? []).includes(slot));
}
