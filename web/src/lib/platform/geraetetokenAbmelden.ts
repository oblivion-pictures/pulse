/**
 * FCM- und PushKit-Token dieses Geräts beim Server abmelden — beim Abmelden
 * und auf dem Weg „Sitzung tot".
 *
 * **An einer Stelle, weil es zwei Wege dorthin gibt** (iOS-Bughunt 2, C2). Das
 * Abmelden (`auth.signOut`) tat es schon; auf dem Weg „Sitzung tot" (der
 * Server lehnt `/refresh` endgültig ab) war die Anmeldung aber schon gelöscht,
 * BEVOR jemand abmeldete — das DELETE lief ohne Ausweis ins 401, still, und
 * das Telefon bekam weiter Banner und Anrufe. `api/client.ts::sitzungTotRaeumen`
 * liest das Zugriffs-Token deshalb VOR dem Löschen und reicht es hierher durch.
 *
 * Ist das Zugriffs-Token schon abgelaufen, bleibt der Ruf ohne Wirkung am
 * Server; die Token fallen dann dort, wo die Kette endet (`push_widerruf.py`). Die Wirkung
 * am Gerät bleibt: `voipTokenAbmelden` vergisst, was es gemeldet hat, und die
 * nächste Anmeldung meldet neu.
 *
 * `bearer` muss der CLOUD-Token sein — FCM- und VoIP-Token liegen immer dort
 * (Bughunt T2), auch wenn gerade ein Self-Host aktiv ist.
 *
 * Auf beiden Wegen räumt es auch die zugestellten System-Meldungen ab
 * (2026-10-20, `zugestellteMeldungen.ts`): sie gehören dem Konto, das geht,
 * und blieben sonst in der Mitteilungszentrale stehen.
 */
import { abmeldeFcmToken } from './fcm';
import { voipTokenAbmelden } from './voipToken';
import { alleZugestelltenMeldungenEntfernen } from './zugestellteMeldungen';

export function geraetetokenAbmelden(bearer: string | undefined): void {
  void abmeldeFcmToken(bearer);
  void voipTokenAbmelden(bearer);
  void alleZugestelltenMeldungenEntfernen();
}
