/**
 * Die Formen an der Grenze zur iOS-Hülle — nur Gestalt, kein Verhalten.
 * Dazu zählt die Liste der Methoden (`SPRACHE_METHODEN`): sie ist die
 * Schnittstelle zur Laufzeit, und sie muss hier stehen, damit der Typ sie
 * vollständig hält.
 *
 * **Warum getrennt von `iosSprache.ts`:** dort steht, was die Brücke TUT,
 * samt der Messungen, die dahinterstehen; zusammen lag die Datei über der
 * Grössen-Policy (`PLAN.md` §12.1). `iosSprache.ts` reicht diese Typen
 * weiter, damit kein Aufrufer seinen Import ändern muss.
 *
 * **Optionale Felder sind hier kein Geschmack, sondern Pflicht.** Web und
 * Hülle werden getrennt ausgeliefert: die Oberfläche kommt bei jedem Start
 * frisch vom Server, die App nur über den Store. Ein Telefon mit älterem
 * Binary bekommt also diese Datei, ohne dass die Hülle die neuen Felder
 * kennt — jedes Feld, das eine ältere Hülle nicht mitschickt, muss optional
 * sein.
 */

/** Teilnehmer in genau der Form, die `voice/livekit.svelte.ts` schon kennt. */
export interface NativerTeilnehmer {
  identity: string;
  name: string;
  userId: string | null;
  isLocal: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  micMuted: boolean;
  cameraOn: boolean;
  connectionQuality: string;
}

export interface NativerZustand {
  verbunden: boolean;
  /** Leer, wenn die Hülle keinen Raum hält — auch während eines
   *  Wiederaufbaus steht hier der Kanal (`verbunden` ist dann `false`). */
  kanalId: string;
  /** Für den Abgleich nach einem Reload: die frische Seite kennt ihn nicht. */
  kanalName?: string;
  /** Zählt die Beitritte der Hülle. Ein `verlassen` mit dieser Zahl trifft
   *  nur genau diesen Raum (Bughunt 2026-10-11, M6). */
  sitzung?: number;
  /** Die Sitzung, die der Nutzer IN DER HÜLLE aufgelegt hat (native Ansicht,
   *  Live Activity) — `null`, solange er das nicht tat. Stimmt sie mit
   *  `sitzung` überein, kam seither kein Beitritt, und ein Resume-Eintrag ist
   *  überholt (Bughunt 2 vom 2026-10-11, B1, `nativAbgleich.ts`). Eine ältere
   *  Hülle schickt das Feld nicht: dann „unbekannt", nie „aufgelegt". */
  aufgelegtSitzung?: number | null;
  teilnehmer: NativerTeilnehmer[];
  mikro: boolean;
  /** Eigene Kamera an? Nach einem Reload der Web-App ist dieses Vollbild die
   *  EINZIGE Quelle, aus der sich der Kamera-Knopf wieder stellen kann — die
   *  Spur lebt im nativen Prozess und überlebt den Reload. */
  kamera?: boolean;
  kameraVorn?: boolean;
  /** Mithören aus. Gilt nur für das Abspielen der fremden Spuren; die
   *  Mikrofon-Hälfte des Discord-Verhaltens bleibt im Web (`setDeafened`).
   *  Der WIRKSAME Stand — während eines Anrufs `true` (s. `pausiert`). */
  taub?: boolean;
  /** Ein Direktanruf hält den Kanal an (Etappe 4, `SpracheRaumStumm.swift`):
   *  Mikrofon zu, Ton aus, bis aufgelegt ist. Ein Mikrofon- oder Taub-Befehl
   *  ändert dann nur, was danach gilt. */
  pausiert?: boolean;
  /** Was nach der Pause gilt — die WAHL des Nutzers neben dem wirksamen
   *  Stand (`SpracheRaumStumm.swift::wunschFelder`, Bughunt 2, B3). Nur
   *  während `pausiert` aussagekräftig; eine ältere Hülle schickt sie nicht
   *  („unbekannt", `voice/nativAbgleich.ts::pausenWunsch`). */
  mikroWunsch?: boolean;
  taubWunsch?: boolean;
  /** Steht die native Kanalansicht gerade? Entscheidet, ob die Web-Leiste den
   *  Griff „zurück in den Kanal" anbietet. */
  ansichtOffen?: boolean;
  /** Warum das Mikrofon beim Beitritt nicht hochkam — `null`, wenn es kam.
   *
   *  **Ein Beitritt ohne Mikrofon ist kein gescheiterter Beitritt**: man kann
   *  zuhören, und die Hülle lässt den Raum deshalb stehen. Vorher warf sie, und
   *  der Raum blieb verbunden ohne dass das Web es wusste — für alle anderen
   *  sass man im Kanal, die eigene Oberfläche sagte „nicht verbunden", und es
   *  gab keinen Weg hinaus. */
  mikrofonFehler?: string | null;
  lautsprecher: boolean;
  /** Was die Session WIRKLICH ausgibt (`Speaker`, `Receiver`, …) — nicht, was
   *  gewünscht wurde. Genau dieser Unterschied war der Befund vom 2026-10-10. */
  route: string;
  /** Diagnose-Felder der Hülle. Die Oberfläche braucht sie nicht, der
   *  Fehlersucher schon — und dieselbe Frage kam am 2026-10-10 zweimal auf:
   *  „ist die Session überhaupt aktiv?" beantwortet `eingaenge` (eine nicht
   *  aktivierte `.playAndRecord`-Session führt keinen Eingang), „führt sie
   *  die Route?" entscheiden `modus` und `optionen` zusammen mit `route`.
   *  Optional, weil eine ältere Hülle sie nicht mitschickt. */
  kategorie?: string;
  modus?: string;
  optionen?: string[];
  engineLaeuft?: boolean;
  eingaenge?: string[];
  fremdTon?: boolean;
}

/** Nutzlast von `eigenerZustand`. Die Felder nach `route` sind optional, weil
 *  eine ältere Hülle sie nicht mitschickt — Web und Hülle werden getrennt
 *  ausgeliefert (Begründung an `nativerSprachwegDa`). */
export interface NativerEigenerZustand {
  mikro: boolean;
  lautsprecher: boolean;
  route: string;
  kamera?: boolean;
  kameraVorn?: boolean;
  taub?: boolean;
  pausiert?: boolean;
  /** Wie in `NativerZustand` (B3). */
  mikroWunsch?: boolean;
  taubWunsch?: boolean;
}

/** Was die Oberfläche hören will — der Befehl `lautstaerken`. */
export interface NativerHoerwunsch {
  /** Faktor je Nutzer-Id, immer die ganze Tabelle. */
  je: Record<string, number>;
  gesamt: number;
  /** Begrenzer am Ende der Wiedergabe (`settings.audio.limiterEnabled`). Eine
   *  ältere Hülle übergeht das Feld und spielt ohne Begrenzer, wie bisher. */
  limiter: boolean;
}

/** Ein Knopf der nativen Ansicht, dessen Regeln im Web liegen
 *  (`SpracheRaum.wunsch` in der Hülle). */
export interface NativerWunsch {
  /** `neuVerbinden` kommt aus dem Band „Mikrofon ausgefallen" der nativen
   *  Ansicht (`SpracheAnsicht.swift`). */
  aktion: 'mikrofon' | 'taub' | 'auflegen' | 'neuVerbinden';
  an: boolean;
}

/** Das Thema der Web-App (`settings.appearance.theme`), mit dem die native
 *  Ansicht öffnet. `system` folgt dem Telefon. Eine ältere Hülle übergeht
 *  das Feld und bleibt dunkel. */
export type AnsichtThema = 'light' | 'dark' | 'system';

export interface SprachePlugin {
  beitreten(o: {
    wsUrl: string;
    token: string;
    kanalId: string;
    kanalName: string;
    startStumm: boolean;
    startTaub: boolean;
    /** Lautstärke je Nutzer-Id und gesamt — schon beim Aufbau, damit die
     *  erste abonnierte Spur richtig klingt. Eine ältere Hülle übergeht sie. */
    lautstaerken?: Record<string, number>;
    gesamt?: number;
    /** Name der Community — nur für die Live Activity „Im Sprachkanal“
     *  (`SpracheLiveAktivitaet.swift`); die Hülle kennt keine Communitys.
     *  Eine ältere Hülle übergeht das Feld, eine neue zeigt ohne es nur den
     *  Kanal. Kein eigener Befehl: der hielte jeden älteren Bau ganz vom
     *  nativen Weg fern (`SPRACHE_METHODEN`). */
    communityName?: string;
    /** „Volle Tonqualität" (Spracheinstellungen, nur iOS): WebRTCs eigene
     *  Verarbeitung statt Apples Voice-Processing, dazu `bitrateKbps` (der
     *  Server-Wert, wie am Desktop). Nur an einen Bau mit Wächter geschickt
     *  (`nativeWacheDa`); ein älterer übergeht die Felder. */
    volleTonqualitaet?: boolean;
    bitrateKbps?: number;
  }): Promise<NativerZustand>;
  verlassen(o: { sitzung?: number }): Promise<void>;
  lautstaerken(o: {
    lautstaerken: Record<string, number>;
    gesamt: number;
    limiter?: boolean;
  }): Promise<NativerZustand>;
  /** Admin-Stumm- und -Taubschaltung im Kanal, je als Liste von Nutzer-Ids —
   *  die ganze Tabelle, wie bei `lautstaerken`. */
  erzwungen(o: { stumm: string[]; taub: string[] }): Promise<NativerZustand>;
  mikrofon(o: { an: boolean }): Promise<NativerZustand>;
  taub(o: { an: boolean }): Promise<NativerZustand>;
  ausgabe(o: { weg: 'lautsprecher' | 'hoermuschel' }): Promise<NativerZustand>;
  kamera(o: { an: boolean }): Promise<NativerZustand>;
  kameraSeite(o: { front: boolean }): Promise<NativerZustand>;
  ansichtOeffnen(o: { thema: AnsichtThema }): Promise<NativerZustand>;
  ansichtSchliessen(): Promise<NativerZustand>;
  zustand(): Promise<NativerZustand>;
  addListener(
    name: 'verbindung',
    cb: (e: { zustand: string; fehler?: string }) => void
  ): Promise<{ remove: () => void }>;
  addListener(
    name: 'teilnehmer',
    cb: (e: { liste: NativerTeilnehmer[] }) => void
  ): Promise<{ remove: () => void }>;
  addListener(
    name: 'sprechen',
    cb: (e: { sprechen: string[] }) => void
  ): Promise<{ remove: () => void }>;
  addListener(
    name: 'eigenerZustand',
    cb: (e: NativerEigenerZustand) => void
  ): Promise<{ remove: () => void }>;
  addListener(
    name: 'ansichtGeschlossen',
    cb: () => void
  ): Promise<{ remove: () => void }>;
  addListener(name: 'wunsch', cb: (e: NativerWunsch) => void): Promise<{ remove: () => void }>;
}

/** Eine Diagnose-Zeile der Hülle (`SpracheRaumNeustart.swift::diagMelden`):
 *  nur Zustände, nie Kennungen. */
export interface NativeDiagnose {
  art: string;
  felder: Record<string, string | number | boolean>;
}

/**
 * Was ein Bau MIT Mikrofon-Wächter zusätzlich kann (seit 2026-10-17).
 *
 * **Bewusst NICHT in `SprachePlugin` und damit nicht in `SPRACHE_METHODEN`.**
 * Jede Methode dort ist Bedingung für den ganzen nativen Weg: ein Bau ohne sie
 * — TestFlight 2.1 im Feld — fiele ganz auf den Web-Weg zurück, also auf
 * WebKits eigene Aufnahme mit allen Fehlern, gegen die der native Weg gebaut
 * wurde. Der Wächter ist ein Zusatz: fehlt er, läuft der Kanal wie bisher,
 * nur ohne Wächter. Gefragt wird deshalb einzeln (`nativeWacheDa`), und alles,
 * was daran hängt (Beitrittston erst nach dem Mikrofon, Tonqualität), gilt
 * nur dann.
 */
export interface SpracheWachePlugin {
  diagnose(): Promise<Record<string, string | number | boolean>>;
  addListener(name: 'mikroBereit', cb: () => void): Promise<{ remove: () => void }>;
  addListener(
    name: 'mikroAusfall',
    cb: (e: { stufe: number }) => void
  ): Promise<{ remove: () => void }>;
  addListener(name: 'mikroTot', cb: (e: { tot: boolean }) => void): Promise<{ remove: () => void }>;
  addListener(name: 'diagnose', cb: (e: NativeDiagnose) => void): Promise<{ remove: () => void }>;
}

/** Das Kennzeichen eines Baus mit Wächter (s. `SpracheWachePlugin`). */
export const SPRACHE_WACHE_METHODEN: readonly string[] = ['diagnose'];

/**
 * Jede Methode, die die Oberfläche auf dem nativen Weg an der Hülle ruft — die
 * Liste, gegen die die Weiche den installierten Bau prüft
 * (`iosSpracheWeiche.ts`). Der Bau muss ALLE kennen, sonst bleibt es beim
 * Web-Weg: ein halber nativer Weg sieht funktionierend aus, wo er es nicht
 * ist (so lief es mit dem Taubstellen, s. `spracheTaub`).
 *
 * **Vom Typ erzwungen vollständig.** Die Schlüssel sind genau die von
 * `SprachePlugin`: wer dort eine Methode ergänzt, bekommt hier einen
 * Typfehler, bis sie auch in der Liste steht. Eine zweite, von Hand gepflegte
 * Aufzählung liefe beim nächsten Zuwachs auseinander — und niemand merkte es,
 * weil der eigene Bau ja alles kennt.
 *
 * `addListener` steht mit drin, obwohl Capacitor es jedem Kopf von sich aus
 * beigibt: die Liste soll die Schnittstelle abbilden, nicht raten, was der
 * Kern ergänzt.
 */
export const SPRACHE_METHODEN: readonly string[] = Object.keys({
  beitreten: true,
  verlassen: true,
  lautstaerken: true,
  erzwungen: true,
  mikrofon: true,
  taub: true,
  ausgabe: true,
  kamera: true,
  kameraSeite: true,
  ansichtOeffnen: true,
  ansichtSchliessen: true,
  zustand: true,
  addListener: true
} satisfies Record<keyof SprachePlugin, true>);
