/**
 * Den Merkzettel der Android-Hülle lesen — die reine Rechnung zu
 * `anrufHuelle.ts::ausstehendeAktionAbholen`.
 *
 * **Wozu.** Die Hülle zeigt bei einem Anruf-Push selbst die Klingel-Meldung
 * (`PushDienst.java`) und reicht den Push NICHT an die WebView weiter. Was sie
 * ohne zuhörende WebView sammelt, hält sie auf einem Zettel bereit
 * (`Anruf.ausstehendeAktion()`, `AnrufSpeicher.java`), den die Seite genau
 * einmal abholt:
 *
 * - **Eine Entscheidung** — „Annehmen" oder „Ablehnen" auf der
 *   Klingel-Meldung, während die WebView nicht lief. Das `aktion`-Ereignis
 *   gab es in dem Moment noch nicht. `alsAnrufAktion` übersetzt sie in die
 *   Form dieses Ereignisses (Felder des Anruf-Pushs in snake_case, s.
 *   `platform/anrufNativ.ts::AnrufAktion`), damit beide Wege in derselben
 *   Verarbeitung landen (`nativeAktionVerarbeiten`).
 * - **Ein Anruf, der noch klingelt** (der Zettel ohne `aktion`). Die Seite
 *   erfährt sonst nicht davon: nach dem Wiederverbinden schickt der Server
 *   keinen Nachtrag (`chat-gateway/routes/anrufe.py`: „kein Gap-Fill"), und
 *   einen Abruf klingelnder Anrufe gibt es nicht. `alsKlingelnderAnruf` macht
 *   daraus die Angabe für `anrufe.eingehend`.
 *
 * Ohne Kennung (oder ohne Kanal beim Klingeln): `null` — dann ist nichts zu
 * tun. Importfrei, damit Nodes Testläufer es prüft (`pnpm test:unit`-Falle).
 */

export interface AktionAusDerHuelle {
  aktion: 'annehmen' | 'ablehnen';
  callId: string;
  channel_id?: string;
  anruf_art?: string;
  einleiter_id?: string;
  einleiter_name?: string;
}

export interface KlingelnderAnruf {
  /** Die Angabe für `anrufe.eingehend` — dieselbe Form wie `call_klingelt`. */
  anruf: { call_id: string; art: 'dm' | 'gruppe'; channel_id: string; einleiter_id: string };
  /** Der Name der Gegenstelle, wie der Server ihn in den Push legte. */
  name: string | null;
}

function text(wert: unknown): string | undefined {
  return typeof wert === 'string' && wert ? wert : undefined;
}

function zettel(roh: unknown): Record<string, unknown> | null {
  return typeof roh === 'object' && roh !== null ? (roh as Record<string, unknown>) : null;
}

export function alsAnrufAktion(roh: unknown): AktionAusDerHuelle | null {
  const r = zettel(roh);
  if (!r) return null;
  const aktion = r.aktion;
  const callId = text(r.callId);
  if ((aktion !== 'annehmen' && aktion !== 'ablehnen') || !callId) return null;
  const ergebnis: AktionAusDerHuelle = { aktion, callId };
  const felder: [keyof AktionAusDerHuelle, unknown][] = [
    ['channel_id', r.channelId],
    ['anruf_art', r.anrufArt],
    ['einleiter_id', r.einleiterId],
    ['einleiter_name', r.einleiterName]
  ];
  for (const [ziel, wert] of felder) {
    const t = text(wert);
    if (t) (ergebnis as unknown as Record<string, string>)[ziel] = t;
  }
  return ergebnis;
}

/** Nur ein Zettel OHNE Entscheidung ist ein klingelnder Anruf — mit
 *  Entscheidung gilt `alsAnrufAktion`. `anruf_art` ist `dm` oder `gruppe`;
 *  alles andere wird `dm` (einen Videoanruf als eigene Art gibt es nicht,
 *  Bughunt G3 in `anrufHuelle.ts`). */
export function alsKlingelnderAnruf(roh: unknown): KlingelnderAnruf | null {
  const r = zettel(roh);
  if (!r || r.aktion !== undefined) return null;
  const callId = text(r.callId);
  const kanal = text(r.channelId);
  if (!callId || !kanal) return null;
  return {
    anruf: {
      call_id: callId,
      art: r.anrufArt === 'gruppe' ? 'gruppe' : 'dm',
      channel_id: kanal,
      einleiter_id: text(r.einleiterId) ?? ''
    },
    name: text(r.einleiterName) ?? null
  };
}
