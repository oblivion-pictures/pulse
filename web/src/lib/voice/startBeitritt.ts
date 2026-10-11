/**
 * Wann ein Sprachkanal OHNE Tipp auf „Beitreten" betreten wird — die reinen
 * Entscheidungen, ohne Laufzeit-Import (Nodes Testläufer, CLAUDE.md; die
 * Typ-Importe unten verschwinden beim Laden unter Node ganz). Verdrahtet in
 * `startBeitritte.ts` (Start-Reihenfolge und `resumeVoiceIfPending`) und in
 * `routenBeitritt.svelte.ts` (Kanal-Route).
 *
 * **Eine Regel statt drei Flicken** (iOS-Bughunt 2 vom 2026-10-11, N1, D1,
 * B1/D2). Ein automatischer Beitritt hat Aussenwirkung: für alle anderen sitzt
 * man danach im Kanal, unter Umständen mit offenem Mikrofon. Er geschieht
 * deshalb nur, wenn alles Folgende gilt:
 *
 *  1. **Der Start ist durch** (`startTor`): die App ist entsperrt (F4) und
 *     der Abgleich mit der Hülle gelaufen. Vorher weiss die Seite nicht, ob
 *     die Hülle noch einen Raum hält — ein Beitritt verdrängte ihn samt Stumm
 *     und Taub (N1).
 *  2. **Ein Anlass, der ihn trägt**: der Resume-Eintrag nach einem Neuladen
 *     (mit dem Stand von vorher) oder ein Tipp in der App (`herkunft.ts`).
 *     Ein Ziel von aussen (D1) und die erste Seite des Dokuments tragen ihn
 *     nicht.
 *  3. **Die Hülle widerspricht nicht**: hat der Nutzer dort selbst aufgelegt,
 *     während die Seite tot war, ist der Resume-Eintrag überholt (B1).
 */

import type { Herkunft } from '$lib/navigation/herkunft';
import type { Abgleich } from './nativAbgleich';
import type { VoiceResume } from './resume';

export type RoutenBeitritt = 'ja' | 'nein' | 'warten';

/**
 * Tritt die Kanal-Route beim Landen auf einem Sprachkanal bei?
 *
 * `nein` ist endgültig (die Route fragt für diese Landung nicht wieder),
 * `warten` heisst: noch einmal fragen, sobald sich `startFertig` oder
 * `gesperrt` ändert.
 *
 * **Die Herkunft wird zuerst geprüft**, vor dem Tor: eine Landung, die keinen
 * Beitritt trägt, muss nicht warten, um das zu erfahren. `imKanal` erst
 * danach — vor dem Abgleich sagt es nichts, weil die Seite einen
 * überlebenden Raum noch gar nicht kennt (N1).
 */
export function routeBeitritt(z: {
  herkunft: Herkunft;
  startFertig: boolean;
  gesperrt: boolean;
  imKanal: boolean;
}): RoutenBeitritt {
  if (z.herkunft !== 'app') return 'nein';
  if (z.gesperrt || !z.startFertig) return 'warten';
  if (z.imKanal) return 'nein';
  return 'ja';
}

/** Was der Abgleich beim Start ergeben hat, aus Sicht des Resume.
 *  `ueberholt`: während der Abfrage hat ein anderer Beitritt oder ein
 *  Auflegen begonnen — der Stand der Abfrage gilt nicht mehr. */
export type StartAbgleich = Abgleich | 'ueberholt';

export type ResumePlan =
  | { beitreten: false; eintragLoeschen: boolean }
  | {
      beitreten: true;
      kanalId: string;
      kanalName: string;
      optionen: { startMuted: boolean; startDeafened: boolean; micBeforeDeafen: boolean };
    };

/**
 * Wieder beitreten nach einem Neuladen? Und mit welchem Stand?
 *
 *  - `uebernehmen`: die Hülle hält den Raum, er ist schon da — nichts tun.
 *  - `verwerfen`: der Nutzer hat in der Hülle selbst aufgelegt (B1). Der
 *    Eintrag ist der Beleg einer Sitzung, die er beendet hat; er wird
 *    gelöscht, sonst träte das NÄCHSTE Neuladen wieder bei.
 *  - `ueberholt` oder schon im Kanal: ein Tipp während der Abfrage hat
 *    gewonnen. Der Eintrag bleibt — der neue Beitritt schreibt seinen eigenen.
 *  - sonst (`nichts`, `verlassen`): der Eintrag entscheidet, und zwar nur im
 *    selben Server-Kontext (andere Token-/Mitgliedschafts-Welt).
 *
 * Stumm und Taub reisen mit — das Wiederaufnehmen stellt den Stand von vorher
 * her, nicht „offen und hörend".
 */
export function resumePlan(z: {
  abgleich: StartAbgleich;
  resume: VoiceResume | null;
  aktiverServer: string;
  imKanal: boolean;
}): ResumePlan {
  if (z.abgleich === 'verwerfen') return { beitreten: false, eintragLoeschen: true };
  if (z.abgleich === 'uebernehmen' || z.abgleich === 'ueberholt' || z.imKanal) {
    return { beitreten: false, eintragLoeschen: false };
  }
  const r = z.resume;
  if (!r || r.serverId !== z.aktiverServer) return { beitreten: false, eintragLoeschen: false };
  return {
    beitreten: true,
    kanalId: r.channelId,
    kanalName: r.channelName,
    optionen: {
      startMuted: r.muted,
      startDeafened: r.deafened,
      micBeforeDeafen: r.micBeforeDeafen
    }
  };
}
