/**
 * A/V-Ausgleich für den nativen Stream-Ton der iOS-Hülle — die reine Rechnung.
 *
 * **Warum es ihn gibt.** Bild (WebView) und Ton (Hülle) laufen über zwei
 * getrennte Lesesitzungen mit zwei Jitterpuffern und ohne gemeinsame Uhr;
 * WebRTCs Lippensynchronität greift nur innerhalb EINER PeerConnection. Der
 * Ton kommt dabei typischerweise früher an: das Bild wartet im Puffer auf
 * vollständige Bilder (`jitterBufferTarget` 120 ms in `whep.ts`) und muss
 * danach noch dekodiert werden.
 *
 * **Was hier „grob" heisst.** Gemessen wird aus WebRTCs eigenen Zählern —
 * `jitterBufferDelay/jitterBufferEmittedCount` beider Seiten, dazu die
 * Dekodierzeit des Bildes und die Ausgabe-Latenz der Ton-Maschine —, nicht
 * aus Zeitstempeln. Die Darstellungszeit der WebView (ein bis zwei Bilder)
 * und die Netzwege beider Sitzungen (derselbe Server, dieselbe Leitung)
 * fehlen in der Rechnung. Deshalb nur verzögern, wo es sich lohnt:
 * Ton VOR dem Bild fällt ab etwa 45 ms auf (ITU-R BT.1359), also ab
 * `SCHWELLE_MS`, in Schritten von mindestens `SCHRITT_MS`, höchstens alle
 * `ABSTAND_MS`, nie über `MAX_MS`. Den umgekehrten Fall (Ton später) kann
 * dieser Weg nicht beheben — dafür müsste das Bild warten.
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`).
 */

export const SCHWELLE_MS = 60;
export const SCHRITT_MS = 40;
export const ABSTAND_MS = 10_000;
export const MAX_MS = 250;

/** Ein kumulativer WebRTC-Zähler: Summe (Sekunden) und Anzahl. */
export interface Zaehler {
  summe: number;
  anzahl: number;
}

/** Mittel über das Fenster zwischen zwei Ablesungen, in ms. `null`, wenn im
 *  Fenster nichts kam oder der Zähler neu begann (neue Sitzung). */
export function fensterMs(vorher: Zaehler | null, jetzt: Zaehler): number | null {
  if (!vorher) return null;
  const n = jetzt.anzahl - vorher.anzahl;
  const s = jetzt.summe - vorher.summe;
  if (n <= 0 || s < 0) return null;
  return (s / n) * 1000;
}

/** Die zwei Zähler des Bildwegs aus einem `getStats()`-Bericht. */
export function videoZaehler(
  eintraege: Iterable<Record<string, unknown>>
): { puffer: Zaehler; dekodieren: Zaehler } | null {
  for (const e of eintraege) {
    if (e.type !== 'inbound-rtp' || e.kind !== 'video') continue;
    const zahl = (k: string) => (typeof e[k] === 'number' ? (e[k] as number) : 0);
    return {
      puffer: { summe: zahl('jitterBufferDelay'), anzahl: zahl('jitterBufferEmittedCount') },
      dekodieren: { summe: zahl('totalDecodeTime'), anzahl: zahl('framesDecoded') }
    };
  }
  return null;
}

export interface VersatzLage {
  /** Weg des Bildes bis zur Anzeige (Puffer + Dekodieren), ms. */
  videoMs: number;
  /** Weg des Tons OHNE die eigene Verzögerung (Puffer + Ausgabe), ms. */
  tonMs: number;
  /** Was gerade eingestellt ist. */
  aktuellMs: number;
  /** Der Vorschlag der vorigen Messung — gesetzt wird erst, wenn zwei
   *  aufeinanderfolgende Messungen übereinstimmen. */
  vorschlagVorher: number | null;
  /** Wie lange die letzte Änderung her ist. */
  seitAenderungMs: number;
}

/** `vorschlag`: was diese Messung will; `setzen`: der neue Wert, falls jetzt
 *  umgestellt werden soll, sonst `null`. */
export function versatzEntscheiden(l: VersatzLage): { vorschlag: number; setzen: number | null } {
  const roh = l.videoMs - l.tonMs;
  const vorschlag = roh < SCHWELLE_MS ? 0 : Math.min(MAX_MS, Math.round(roh / 10) * 10);
  const stabil =
    l.vorschlagVorher !== null && Math.abs(l.vorschlagVorher - vorschlag) < SCHRITT_MS;
  const lohnt = Math.abs(vorschlag - l.aktuellMs) >= SCHRITT_MS;
  const ruhig = l.seitAenderungMs >= ABSTAND_MS;
  return { vorschlag, setzen: stabil && lohnt && ruhig ? vorschlag : null };
}

/** Pfad einer WHEP-URL ohne Abfrage (das Lese-Token wechselt bei jedem
 *  `GET /whep`, der Pfad nur bei einer neuen Übertragung). */
export function whepPfad(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Darf diese WHEP-URL an die Hülle? Nur auf einen der eigenen Pulse-Hosts
 * (Cloud, aktiver Server, die Seite selbst) und nur über https — http allein
 * für eine lokale Entwicklungsadresse. Die Hülle schickt die URL ohne CORS
 * und ohne Rückfrage per POST hinaus; was hier durchkommt, bestimmt, wohin
 * das Telefon eine Verbindung aufbaut (Gegenprüfung 2026-10-17, Randnotiz).
 * `erlaubt`: Hostnamen oder Ursprünge, fehlende Einträge zählen nicht.
 */
export function whepHostErlaubt(url: string, erlaubt: readonly (string | undefined)[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const lokal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && lokal)) return false;
  const hosts = erlaubt.flatMap((e) => {
    if (!e) return [];
    try {
      return [new URL(e.includes('://') ? e : `https://${e}`).host];
    } catch {
      return [];
    }
  });
  return hosts.includes(u.host);
}
