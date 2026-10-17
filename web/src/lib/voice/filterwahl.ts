/**
 * Welcher eigene Sendefilter läuft — aus Einstellung und Makeup-Pegel.
 *
 * Bis zum 2026-10-18 stand hier auch die Frage „filtert das System schon?"
 * (iOS, `.voiceChat`): zwei Rauschunterdrückungen in Reihe schneiden
 * Wortanfänge ab. Seit der Web-Sprachweg der iOS-Hülle entfernt ist
 * (Eigentümer-Entscheid E6) gibt es auf iOS keinen JS-Raum mehr, dessen
 * Sendefilter das beträfe; im Browser und auf Android filtert das System nie
 * unabschaltbar im Sendeweg. Die Rechnung hängt deshalb nur noch am Wunsch.
 *
 * **Der Makeup-Pegel ist keine Filterung, sondern eine Verstärkung** und gilt
 * unabhängig vom Wunsch.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */

/** Was die Einstellung des Nutzers sagt. Spiegel von `NoiseSuppressionMode`. */
export type Wunsch = 'off' | 'rnnoise_gated';

/** Was tatsächlich installiert wird. `keiner` = Prozessor abbauen. */
export type Filterziel = 'rnnoise_gated' | 'gain_only' | 'keiner';

export interface Filterlage {
  wunsch: Wunsch;
  /** Makeup-Verstärkung; `1` = unverändert. */
  makeup: number;
}

export function filterziel(lage: Filterlage): Filterziel {
  if (lage.wunsch === 'rnnoise_gated') return 'rnnoise_gated';
  return lage.makeup !== 1 ? 'gain_only' : 'keiner';
}
