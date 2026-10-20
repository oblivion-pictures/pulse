/**
 * Zugestellte System-Meldungen wieder wegräumen — in den Hüllen (Android, iOS).
 *
 * **Der Befund (2026-10-20):** eine Push-Meldung blieb in der Mitteilungs-
 * zentrale stehen, bis man sie selbst wegwischte — auch nachdem man die
 * Unterhaltung in der App längst gelesen hatte, auf diesem oder einem anderen
 * Gerät. Jetzt räumt das Lesen einer Unterhaltung (DM, private Gruppe,
 * Community-Kanal) ihre Meldungen ab, und das Abmelden räumt alle ab.
 *
 * **Angestossen von `readState.markRead`** (Haken `beimLesen`, eingehängt in
 * `fcm.ts::installiereFcmPush`): das ist der eine Punkt, an dem „gelesen"
 * entsteht — Öffnen eines Kanals, eine neue Nachricht im offenen Gespräch,
 * „Als gelesen markieren".
 *
 * **Entprellt:** `markRead` feuert beim Lesen oft mehrmals kurz hintereinander;
 * die Kanäle werden gesammelt und einmal je `ENTPRELL_MS` an die Hülle
 * gegeben. Welche Meldung zu welchem Kanal gehört, regelt
 * `meldungZuordnung.ts`.
 *
 * **Fail-safe:** jeder Ruf an die Hülle steht in `try`/`catch`. Eine Hülle
 * ohne Firebase-Plugin oder mit einer Version, die eine der Methoden nicht
 * kennt, lässt die Meldungen einfach stehen — wie bisher.
 */
import { fcmPlugin } from './fcmPlugin';
import { meldungGehoertZu } from './meldungZuordnung';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';

const ENTPRELL_MS = 500;

const vorgemerkt = new Set<string>();
let wecker: ReturnType<typeof setTimeout> | null = null;

function huelle(): boolean {
  return isCapacitorAndroid() || isCapacitorIOS();
}

async function abraeumen(kanaele: ReadonlySet<string>): Promise<void> {
  const fcm = fcmPlugin();
  if (!fcm) return;
  try {
    const { notifications } = await fcm.getDeliveredNotifications();
    const weg = (notifications ?? []).filter((n) => meldungGehoertZu(n, kanaele));
    if (weg.length > 0) await fcm.removeDeliveredNotifications({ notifications: weg });
  } catch {
    /* Ältere Hülle / kein Plugin — die Meldungen bleiben stehen, wie bisher. */
  }
}

/** Die zugestellten Meldungen dieser Unterhaltung wegräumen (entprellt). */
export function zugestellteMeldungenEntfernen(kanalId: string): void {
  if (!kanalId || !huelle()) return;
  vorgemerkt.add(kanalId);
  if (wecker !== null) return;
  wecker = setTimeout(() => {
    wecker = null;
    const kanaele = new Set(vorgemerkt);
    vorgemerkt.clear();
    void abraeumen(kanaele);
  }, ENTPRELL_MS);
}

/** Beim Abmelden: alle zugestellten Meldungen dieser App wegräumen — sie
 *  gehören dem Konto, das gerade geht. */
export async function alleZugestelltenMeldungenEntfernen(): Promise<void> {
  if (!huelle()) return;
  if (wecker !== null) {
    clearTimeout(wecker);
    wecker = null;
  }
  vorgemerkt.clear();
  try {
    await fcmPlugin()?.removeAllDeliveredNotifications();
  } catch {
    /* Ältere Hülle / kein Plugin — still. */
  }
}
