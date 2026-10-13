/**
 * Die Rechnung hinter allen Änderungen an BEREITS vorhandenen Nachrichten im
 * Nachrichten-Store (`stores/messages.svelte.ts`): Reaktionen, Pins und der
 * Abgleich mit einem frisch geholten Serverstand. Der Store sucht die
 * Nachricht und schreibt das Ergebnis zurück; was dazwischen geschieht, steht
 * hier — ohne Zustand, ohne Rune, mit Nodes Testlauf prüfbar.
 *
 * Importfrei im Sinn der `pnpm test:unit`-Falle (s. CLAUDE.md): nur ein reiner
 * Typ-Import, den Node beim Laden verwirft.
 */
import type { Message, ReactionAggregate } from '../api/types';

/** Wendet ein Reaktions-Delta auf die Liste einer Nachricht an: `+1` fügt hinzu,
 *  `-1` nimmt weg. `ichBins` ist gesetzt, wenn dieses Konto der Reagierende ist.
 *  Liefert eine NEUE Liste (Einträge werden kopiert, die alte bleibt
 *  unangetastet) — oder `null`, wenn es nichts zu tun gibt: ein Entfernen für
 *  ein Emoji, das gar nicht in der Liste steht. */
export function reaktionAnwenden(
  bisher: ReactionAggregate[] | undefined,
  emoji: string,
  delta: 1 | -1,
  ichBins: boolean
): ReactionAggregate[] | null {
  const reactions: ReactionAggregate[] = bisher ? bisher.map((r) => ({ ...r })) : [];
  const rIdx = reactions.findIndex((r) => r.emoji === emoji);
  if (delta === 1) {
    if (rIdx < 0) reactions.push({ emoji, count: 1, me: ichBins });
    else {
      reactions[rIdx].count += 1;
      if (ichBins) reactions[rIdx].me = true;
    }
  } else {
    if (rIdx < 0) return null;
    reactions[rIdx].count -= 1;
    if (ichBins) reactions[rIdx].me = false;
    if (reactions[rIdx].count <= 0) reactions.splice(rIdx, 1);
  }
  return reactions;
}

/** Zwei Reaktionslisten strukturell vergleichen, ohne zu serialisieren. */
export function reaktionenGleich(a: ReactionAggregate[], b: ReactionAggregate[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (ra.emoji !== rb.emoji || ra.count !== rb.count || ra.me !== rb.me) return false;
  }
  return true;
}

const jetztIso = (): string => new Date().toISOString();

/** Schreibt die Pin-Liste eines Kanals nach einem `pin_update` fort. `geladen`
 *  ist die Nachricht selbst, falls sie im Historie-Fenster liegt — sie liefert
 *  den vollständigen Listeneintrag (dem WS-Payload fehlen Inhalt und Autor);
 *  fehlt sie, kommt ein schmaler Platzhalter. Die Sortierung nach `pinned_at`
 *  repariert der nächste Listen-Fetch, bis dahin hängt ein neuer Pin hinten an.
 *  Gibt dieselbe Liste zurück, wenn sich nichts ändert (Pin schon drin bzw.
 *  Entpinnen von etwas, das nicht drin ist). `jetzt` ist für Tests
 *  austauschbar. */
export function pinsFortschreiben(
  list: Message[],
  evt: { channel_id: string; message_id: string; pinned: boolean },
  geladen: Message | undefined,
  jetzt: () => string = jetztIso
): Message[] {
  const idx = list.findIndex((p) => p.id === evt.message_id);
  if (evt.pinned) {
    if (idx >= 0) return list;
    const entry: Message = geladen
      ? { ...geladen, pinned_at: jetzt() }
      : ({ id: evt.message_id, channel_id: evt.channel_id, pinned_at: jetzt() } as Message);
    return [...list, entry];
  }
  return idx >= 0 ? list.filter((p) => p.id !== evt.message_id) : list;
}

/** Der `pinned_at`-Spiegel auf der Nachricht selbst: ein bestehender Zeitpunkt
 *  bleibt beim Pinnen erhalten, Entpinnen setzt ihn zurück. */
export function pinSpiegel(msg: Message, pinned: boolean, jetzt: () => string = jetztIso): Message {
  return { ...msg, pinned_at: pinned ? (msg.pinned_at ?? jetzt()) : null };
}

/** Arbeitet den Stand einer frisch geholten Seite in die vorhandene Liste ein:
 *  `content`, `edited_at` und `reactions` der Nachrichten, die in beiden
 *  vorkommen. Neue Nachrichten in `msgs` bleiben unbeachtet. Gibt DIESELBE
 *  Liste zurück, wenn nichts abweicht — der Aufrufer erkennt daran, dass er
 *  nichts schreiben muss. */
export function abgleichen(list: Message[], msgs: Message[]): Message[] {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  let changed = false;
  const next = list.map((cur) => {
    const fresh = byId.get(cur.id);
    if (!fresh) return cur;
    const merged: Message = {
      ...cur,
      content: fresh.content,
      edited_at: fresh.edited_at,
      reactions: fresh.reactions ?? cur.reactions
    };
    if (
      merged.content === cur.content &&
      merged.edited_at === cur.edited_at &&
      reaktionenGleich(merged.reactions ?? [], cur.reactions ?? [])
    ) {
      return cur;
    }
    changed = true;
    return merged;
  });
  return changed ? next : list;
}
