/**
 * Die reinen Entscheidungen des nativen Sprachwegs auf iOS — ohne Import,
 * damit Nodes Testläufer sie prüfen kann (CLAUDE.md, `pnpm test:unit`-Falle).
 * Verdrahtet werden sie in `nativerRaum.svelte.ts`. Die beiden Typ-Importe
 * unten verschwinden beim Übersetzen und beim Laden unter Node ganz.
 */

import type { NativerTeilnehmer } from '$lib/platform/iosSpracheTypen';
import type { VoiceParticipant } from './livekit.svelte';

/** Ein Verbindungszustand der Hülle, als schlichtes Wort. */
export type HuellenVerbindung =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnecting'
  | 'disconnected';

/**
 * Das Wort aus dem `verbindung`-Ereignis — **mit und ohne führenden Punkt.**
 *
 * Bis zum 2026-10-11 schickte die Hülle `"\(state)"`, und LiveKits
 * `description` setzt einen Punkt davor (`.connected`). Der Hörer verglich
 * mit `connected`: der Zweig griff nie, ein Wiederaufbau wurde nie angezeigt
 * (Bughunt 2026-10-11, G1). Die Hülle schickt seither das schlichte Wort
 * (`SpracheRaum.verbindungsName`) — aber Web und Hülle werden getrennt
 * ausgeliefert, und ältere Hüllen schicken den Punkt weiter. Deshalb liest
 * diese Seite beides.
 */
export function verbindungAusHuelle(roh: string): HuellenVerbindung | null {
  const wort = roh.startsWith('.') ? roh.slice(1) : roh;
  switch (wort) {
    case 'connected':
    case 'connecting':
    case 'reconnecting':
    case 'disconnecting':
    case 'disconnected':
      return wort;
    default:
      return null;
  }
}

/** Was nach einem Reload mit einem Raum geschieht, den die Hülle noch hält
 *  — oder mit dem Resume-Eintrag, wenn sie keinen mehr hält (`verwerfen`).
 *  `pruefraum`: die Hülle hält den Raum eines DEBUG-Prüfpfads, und den lässt
 *  die Seite stehen (`istPruefraum`). */
export type Abgleich = 'nichts' | 'uebernehmen' | 'verlassen' | 'verwerfen' | 'pruefraum';

/**
 * **Hält die Hülle den Raum eines Prüfpfads?** Die DEBUG-Prüfpfade
 * (`SprachePluginProbe.swift`, `AnrufProbe.swift` …) treten mit der
 * Kanal-Kennung `probe` bzw. `probe-kanal` bei — ohne Oberfläche und ohne
 * Eintrag fürs Wiederaufnehmen. Ohne diese Ausnahme verliess der
 * Start-Abgleich ihren Raum wenige Sekunden nach dem Start wie jeden
 * unbestätigten (Abnahme-Checkliste vom 2026-10-11, Abschnitt 0.8), und
 * jeder Prüfpfad mit Sprachraum lief ins Leere.
 *
 * **Eine Ausnahme NUR für Prüfräume.** Echte Kanäle tragen Snowflake-Kennungen
 * aus Ziffern, und die Oberfläche tritt nie mit etwas anderem bei; ein
 * Release-Bau hat die Prüfpfade gar nicht. Für jeden anderen Raum gilt die
 * Regel oben unverändert.
 */
export function istPruefraum(kanalId: string): boolean {
  return kanalId === 'probe' || kanalId.startsWith('probe-');
}

/**
 * Übernehmen oder verlassen? (Entwurf §5: „Ein Reload der Web-App darf den
 * Raum nicht reissen. Nativ lebt weiter; das Web fragt beim Start `zustand()`
 * und stellt sich darauf ein.")
 *
 * **Übernommen wird nur, was der Eintrag fürs Wiederaufnehmen bestätigt** —
 * derselbe Kanal, derselbe aktive Server. Der Eintrag ist der Beleg, dass
 * DIESE Sitzung den Raum betreten hat: er wird bei jedem Beitritt geschrieben
 * und beim Auflegen, Abmelden und Kontowechsel gelöscht (`resume.ts`). Fehlt
 * er, wurde er mit Absicht gelöscht; ein Raum ohne ihn gehört womöglich einem
 * anderen Konto — und ein Raum, den die Oberfläche nicht kennt, ist der
 * schlimmste denkbare Zustand: für alle anderen sitzt man im Kanal, unter
 * Umständen mit offenem Mikrofon, und es gibt keinen Knopf zum Gehen
 * (Bughunt 2026-10-11, E5). Deshalb: alles, was nicht bestätigt ist, wird
 * verlassen, nicht übernommen.
 *
 * Hält die Hülle keinen Raum mehr, weil der Nutzer ihn dort aufgelegt hat,
 * heisst das Ergebnis `verwerfen`: der Eintrag ist überholt
 * (`vomNutzerAufgelegt`, B1).
 */
export function abgleichEntscheiden(z: {
  huelle: { kanalId: string; sitzung?: number; aufgelegtSitzung?: number | null } | null;
  resume: { serverId: string; channelId: string } | null;
  aktiverServer: string;
}): Abgleich {
  if (!z.huelle) return 'nichts';
  if (!z.huelle.kanalId) return vomNutzerAufgelegt(z.huelle) ? 'verwerfen' : 'nichts';
  if (istPruefraum(z.huelle.kanalId)) return 'pruefraum';
  if (!z.resume) return 'verlassen';
  if (z.resume.serverId !== z.aktiverServer) return 'verlassen';
  if (z.resume.channelId !== z.huelle.kanalId) return 'verlassen';
  return 'uebernehmen';
}

/**
 * Hat der Nutzer die LETZTE Sitzung der Hülle dort selbst aufgelegt — in der
 * nativen Ansicht oder in der Live Activity, ohne dass die Oberfläche es
 * mitbekam (Bughunt 2 vom 2026-10-11, B1)?
 *
 * Nach einem WebContent-Absturz hört drüben niemand mehr zu; die Hülle legt
 * dann allein auf, und ihr „getrennt" geht ins Leere. Der Resume-Eintrag
 * blieb stehen, und das Neuladen trat wieder bei — in einen Kanal, den der
 * Nutzer eben verlassen hatte. Die Hülle merkt sich deshalb, WELCHE Sitzung
 * sie so beendet hat (`aufgelegtSitzung`, `SpracheRaum.vomNutzerAufgelegt`).
 * Gilt nur, solange seither kein Beitritt kam: jeder zählt `sitzung` hoch.
 *
 * **Ein fehlendes Feld heisst „unbekannt", nie „aufgelegt"** — eine ältere
 * Hülle schickt es nicht, und für sie bleibt alles beim Alten.
 */
export function vomNutzerAufgelegt(h: { sitzung?: number; aufgelegtSitzung?: number | null }): boolean {
  return typeof h.aufgelegtSitzung === 'number' && h.aufgelegtSitzung === h.sitzung;
}

/**
 * Hält die Hülle einen Raum? Ihr `zustand()` meldet `kanalId` genau so lange,
 * wie der Raum steht (`SpracheRaum.raumLoesen` leert beides zusammen) — auch
 * während eines Wiederaufbaus, wenn `verbunden` falsch ist.
 */
export function huelleHaeltRaum(z: { kanalId?: string } | null): boolean {
  return Boolean(z?.kanalId);
}

/** Was der Nutzer für Mikrofon und Mithören gewählt hat (B3). */
export interface NutzerWahl {
  mikro: boolean;
  taub: boolean;
}

/**
 * **Was der Nutzer während einer Anruf-Pause WILL** — oder `null`, wenn keine
 * Pause läuft oder die Hülle es nicht sagt (iOS-Bughunt 2 vom 2026-10-11, B3).
 *
 * Hält ein Direktanruf den Kanal an, melden `mikro` und `taub` den WIRKSAMEN
 * Stand: zu und taub. So sehen es die anderen im Kanal, und das ist richtig.
 * Als Wahl des Nutzers gelesen trug er sich aber weiter — ein Kanalwechsel
 * während des Anrufs trat „stumm und taub" bei, und das blieb nach dem
 * Auflegen; ebenso der Eintrag fürs Wiederaufnehmen. Wer weitergibt, was der
 * Nutzer gewählt hat, fragt deshalb zuerst hier.
 *
 * **Ein fehlendes Feld heisst „unbekannt"** — eine ältere Hülle schickt keins,
 * und dann bleibt es beim wirksamen Stand wie bisher.
 */
export function pausenWunsch(z: {
  pausiert?: boolean;
  mikroWunsch?: boolean;
  taubWunsch?: boolean;
}): NutzerWahl | null {
  if (z.pausiert !== true) return null;
  if (typeof z.mikroWunsch !== 'boolean' || typeof z.taubWunsch !== 'boolean') return null;
  return { mikro: z.mikroWunsch, taub: z.taubWunsch };
}

/**
 * Schaut der Nutzer gerade auf diesen Kanal? Genau dann — und nur dann —
 * legt sich die native Kanalansicht nach einem Beitritt darüber.
 *
 * **Die Frage stellt der Pfad, nicht der Anlass des Beitritts.** Ein Tipp auf
 * einen Sprachkanal navigiert im Web dorthin (Entwurf §5); ein
 * `voice_pull`, das Wiederaufnehmen nach einem Reload oder der automatische
 * Beitritt beim Start tun es nicht. Bis zum 2026-10-11 öffnete JEDER Beitritt
 * die Ansicht, und ein Moderator, der einen in seinen Kanal holte, legte ein
 * Vollbild über die offene Unterhaltung (Bughunt 2026-10-11, M3).
 *
 * Nur die Kanal-Route selbst zählt, mit Segmentgrenze — die
 * Rechte-Unterseite desselben Kanals nicht.
 */
export function routeZeigtKanal(pfad: string, kanalId: string): boolean {
  if (!kanalId) return false;
  const teile = pfad.split('/').filter(Boolean);
  return (
    teile.length === 5 &&
    teile[0] === 'app' &&
    teile[1] === 'guilds' &&
    teile[3] === 'channels' &&
    teile[4] === kanalId
  );
}

/**
 * Ein Teilnehmer der Hülle in der Form des Voice-Stores. **Feld für Feld, kein
 * Spreizen:** was die Hülle künftig zusätzlich schickt, soll nicht ungefragt
 * im Store landen. Aus `nativerRaum.svelte.ts` hierher gezogen (Grössen-Policy,
 * `PLAN.md` §12.1), unverändert.
 */
export function teilnehmerAusHuelle(t: NativerTeilnehmer): VoiceParticipant {
  return {
    identity: t.identity,
    name: t.name,
    userId: t.userId,
    isLocal: t.isLocal,
    isSpeaking: t.isSpeaking,
    audioLevel: t.audioLevel,
    micMuted: t.micMuted,
    cameraOn: t.cameraOn,
    connectionQuality: t.connectionQuality as VoiceParticipant['connectionQuality']
  };
}
