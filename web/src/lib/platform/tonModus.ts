/**
 * Welche Audio-Betriebsart die App gerade braucht — die reine Entscheidung.
 *
 * **Warum es überhaupt eine Entscheidung gibt:** Auf iOS gibt es EINE
 * Audio-Session je Prozess. Den Sprachkanal und die Anrufe hält in der Hülle
 * der native Raum (Eigentümer-Entscheide E6, 2026-10-18: kein Web-Weg mehr);
 * hier bleibt der Ton einer angesehenen Stream-Kachel oder Watch-Party in der
 * WebView (nur Wiedergabe). Der Fehler, den der Review am 2026-10-08 fand —
 * das Verlassen eines Sprachkanals rief `setActive(false)` und riss damit den
 * laufenden Stream-Ton mit, weil die Session prozessweit gilt —, lebt heute in
 * der Regel `nativerRaum` weiter: solange die Hülle einen Raum hält, wird die
 * Session hier nicht angefasst (`tonSchritt`).
 *
 * Importfrei, damit Nodes Testläufer die Entscheidung prüfen kann (s.
 * `pnpm test:unit`-Falle im CLAUDE.md); die Verdrahtung ans Plugin steht
 * daneben in `iosTon.ts`.
 */

export type TonModus = 'wiedergabe' | 'aus';

export function zielModus(anzahlWiedergaben: number): TonModus {
  return anzahlWiedergaben > 0 ? 'wiedergabe' : 'aus';
}

/** Darf `iosTon` die Session jetzt einrichten? */
export type TonSchritt = 'nichts' | 'anwenden';

/**
 * Die ganze Entscheidung vor jedem Griff an die Session.
 *
 * - **`nativerRaum`: nie.** Hält die Hülle einen Sprachraum, gehört die
 *   Session LiveKit (`AudioManager` im selben Prozess, dieselbe
 *   `AVAudioSession.sharedInstance()`). Bis zum 2026-10-11 stellte ein
 *   angesehener Stream sie auf `.playback` (kein Eingang mehr) und sein
 *   Schliessen deaktivierte sie mitten im Gespräch — LiveKit richtet sie nur
 *   bei einer Änderung SEINER Anforderungen neu ein, also blieb es so
 *   (Bughunt 2026-10-11, K2, am SDK-Quelltext nachgelesen). Dasselbe galt für
 *   einen Direktanruf neben dem nativen Kanal.
 * - sonst nur, wenn das Ziel nicht schon angewandt ist.
 */
export function tonSchritt(z: {
  ziel: TonModus;
  angewandt: TonModus;
  nativerRaum: boolean;
}): TonSchritt {
  if (z.nativerRaum) return 'nichts';
  return z.ziel === z.angewandt ? 'nichts' : 'anwenden';
}

/**
 * Was nach dem Ende des nativen Raums als angewandt gilt.
 *
 * `aus`, weil die Session danach deaktiviert ist: nach einem Raum durch LiveKit
 * selbst (`AudioSessionEngineObserver.configureAudioSession`: `setActive(false)`,
 * sobald weder Wiedergabe noch Aufnahme läuft), nach dem nativen Stream-Ton
 * durch die Hülle (`StreamTonSitzung.nachDemLetzten` — LiveKit deaktiviert
 * dort bewusst nicht, s. `loslassen`). Läuft dann noch ein Stream,
 * richtet der nächste Schritt `wiedergabe` neu ein; läuft nichts, bleibt es
 * bei LiveKits Deaktivierung — ein zweites `setActive(false)` wäre nur ein
 * weiterer Griff an eine Session, die gerade jemand anderes losgelassen hat.
 */
export const NACH_NATIVEM_RAUM: TonModus = 'aus';
