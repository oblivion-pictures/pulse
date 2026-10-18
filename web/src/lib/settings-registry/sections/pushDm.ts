/**
 * `push`-Abschnitt — der DM-Schalter, den der SERVER kennen muss.
 *
 * Telefon-Pushes (iOS und Android, beide über FCM) sendet der Server — er muss
 * den DM-Schalter der Hülle kennen und schickte sonst weiter, auch wenn der
 * Nutzer DMs abgeschaltet hatte. Dieser Abschnitt spiegelt ihn deshalb in
 * `user_preferences` (`persistence: 'both'`, Abschnittsname `push` —
 * `fcm_stumm.PUSH_ABSCHNITT` im chat-gateway liest `{"dm": false}`).
 * Geschrieben und angezeigt wird er nur in den Hüllen-Einstellungen; Desktop
 * und Browser behalten `notifications.onDM` (Seiten-Hinweise, lokal pro Gerät).
 *
 * Nutzergebunden: das nächste Konto am selben Gerät erbt den Schalter nicht
 * (`onSignOut: 'reset'`); die Vorgabe `dm: true` ist das Bestandsverhalten.
 * Der Server schweigt nur bei einem ausdrücklichen `false`.
 */
import type { SectionConfig } from '../types';

export type PushDmSettings = {
  dm: boolean;
};

export const PUSH_ABSCHNITT = 'push';

const DEFAULTS_PUSH_DM: PushDmSettings = { dm: true };

export const PUSH_DM_SECTION: SectionConfig<PushDmSettings> = {
  defaults: DEFAULTS_PUSH_DM,
  persistence: 'both',
  onSignOut: 'reset',
  parse(raw) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<PushDmSettings>;
    return { dm: typeof p.dm === 'boolean' ? p.dm : DEFAULTS_PUSH_DM.dm };
  }
};
