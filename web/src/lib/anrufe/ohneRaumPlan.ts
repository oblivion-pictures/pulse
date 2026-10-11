/**
 * **Ein Anruf, den die Hülle nach einem Neuladen ohne Raum hält** — was die
 * neue Seite damit tut (iOS-Bughunt 2 vom 2026-10-11, A10).
 *
 * Bis dahin übernahm die Seite nur einen Anruf, dessen nativer Raum schon
 * stand (`nativesGespraech` fragte nach `kennung`, und die meldet die Hülle
 * erst ab dem Beitritt). Lud die Oberfläche zwischen Annahme und Beitritt
 * neu (WebContent-Absturz) oder während es klingelte, stand der CallKit-Anruf
 * ohne Oberfläche da: ein Gespräch ohne Ton, der Kanal angehalten, und nur der
 * System-Bildschirm konnte es beenden.
 *
 * Die Hülle meldet ihn seither in `raumZustand().ohneRaum`
 * (`AnrufPluginRaum.swift`). Daraus:
 *
 *  - **klingelt** (mit Kanal aus dem Push): wieder anzeigen — die Seite
 *    kennt ihn nicht, weil das `call_klingelt` vor dem Neuladen kam.
 *  - **angenommen** (mit Kanal): die Annahme fortsetzen, die der Nutzer schon
 *    gegeben hat. Der Server nimmt sie idempotent; war der Anruf inzwischen
 *    vorbei, räumt der Fehlschlag ab wie jede gescheiterte Annahme.
 *  - **sonst** (ausgehend, oder angenommen ohne Kanal — beides hat die Seite
 *    selbst begonnen, und mit ihr ist der Anruf-Schlüssel weg): beenden, am
 *    Server und bei CallKit. Fortsetzen ginge nicht, und ein stehen gelassener
 *    Anruf ist der schlimmere Zustand.
 *
 * Importfrei, damit Nodes Läufer es prüfen kann (CLAUDE.md, `pnpm test:unit`).
 */

/** Was die Hülle meldet (`Anrufverwaltung.ohneRaum`). */
export interface AnrufOhneRaum {
  kennung: string;
  /** `klingelt`, `angenommen` oder `ausgehend`. */
  phase: string;
  /** Aus dem VoIP-Push: `channel_id`, `anruf_art`, `einleiter_id`,
   *  `einleiter_name` — leer für einen Anruf, den die Seite begonnen hat. */
  kontext: Record<string, string | undefined>;
}

export type OhneRaumPlan =
  | {
      tun: 'klingeln' | 'annehmen';
      anruf: { call_id: string; art: 'dm' | 'gruppe'; channel_id: string; einleiter_id: string };
      name: string;
    }
  | { tun: 'beenden'; kennung: string };

/** `null`: nichts zu tun — kein solcher Anruf, oder eine Hülle, die das Feld
 *  nicht kennt („unbekannt", dann bleibt es wie bisher). */
export function ohneRaumPlan(o: AnrufOhneRaum | null | undefined): OhneRaumPlan | null {
  if (!o?.kennung) return null;
  const kanal = o.kontext?.channel_id;
  if (kanal && (o.phase === 'klingelt' || o.phase === 'angenommen')) {
    return {
      tun: o.phase === 'klingelt' ? 'klingeln' : 'annehmen',
      anruf: {
        call_id: o.kennung,
        art: o.kontext.anruf_art === 'gruppe' ? 'gruppe' : 'dm',
        channel_id: kanal,
        einleiter_id: o.kontext.einleiter_id ?? ''
      },
      name: o.kontext.einleiter_name || 'Pulse'
    };
  }
  return { tun: 'beenden', kennung: o.kennung };
}
