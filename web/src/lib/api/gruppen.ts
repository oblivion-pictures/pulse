/**
 * Private Gruppenkanaele — REST-Client.
 *
 * Wire-Form spiegelt `services/chat-gateway/.../routes/private_gruppen.py` +
 * `schemas.py` (`PrivateGroupOut`, `PrivateGroupCreateIn`,
 * `PrivateGroupMemberAddIn`). Die Routen liegen im Wurzel-Router ohne
 * Prefix — also `/gruppen`, nicht `/chat/gruppen`.
 *
 * **Jede Funktion ist hinter `PRIVATE_GRUPPEN_ENABLED` verriegelt** (s.
 * `krypto/schalter.ts`): bei ausgeschaltetem Schalter geht kein einziger
 * Aufruf hinaus. Der Riegel sitzt HIER und nicht bei den Aufrufern, weil
 * „nichts laeuft" sonst an jeder Aufrufstelle einzeln zu wiederholen waere —
 * und genau eine vergessene Stelle macht die Zusage kaputt. Was der Schalter
 * nicht kann, ist eine Antwort erfinden: die Funktionen liefern `null` bzw.
 * eine leere Liste, und der Aufrufer behandelt das wie „es gibt keine
 * Gruppen".
 *
 * **Cloud-only, wie DMs** — der Router traegt `CloudOnly`
 * (`routes/private_gruppen.py`), und die Gegenstellen-Schluessel liegen im
 * Cloud-Verzeichnis. Ohne die ausdrueckliche Route liefe der Aufruf gegen
 * den zuletzt gewaehlten Self-Host (`api/keys.ts`-Modulkopf, Bughunt
 * 2026-08-28 FIX 4).
 */

import { request, requestForm } from './client';
import { serversStore } from './servers.svelte';
import { PRIVATE_GRUPPEN_ENABLED } from '../krypto/schalter';

export interface GruppenMitglied {
  user_id: string;
  /** „owner" / „admin" / „mitglied" — Rollen-Vertrag 2026-10-19. */
  rolle: string;
  /** Persönliche Stummschaltung — nur in der EIGENEN Zeile; die der anderen
   *  liefert der Server nicht aus. Gelesen wird sie allein über
   *  `privateGruppen.eigenesStumm`. */
  stumm?: boolean | null;
  beigetreten_am: string;
  /** Häkchen-Treppe (Migration 0101): Lesestand dieses Mitglieds und
   *  Zustellstand der EIGENEN Nachrichten bei ihm — nur in `auflisten`/
   *  `lesen` gefüllt, s. `stores/quittungen.svelte.ts`. */
  gelesen_bis?: string | null;
  zugestellt_bis?: string | null;
}

export interface PrivateGruppe {
  id: string;
  ersteller_id: string;
  name: string;
  created_at: string;
  last_message_id: string | null;
  /** Gruppenbild — Pfad `/api/chat/gruppen-icons/<id>-<token>.webp` (Token
   *  unratbar, wechselt bei jedem Upload) oder
   *  null = keine (Anfangsbuchstaben-Kachel). */
  icon_url: string | null;
  /** Der eine angeheftete Kanal-Anker (E2E: nur die Zeichenkette) oder null. */
  angeheftet_id: string | null;
  members: GruppenMitglied[];
}

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

export const gruppenApi = {
  /** Alle eigenen Gruppen. Leer, solange der Schalter aus ist. */
  auflisten(): Promise<PrivateGruppe[]> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve([]);
    return request<PrivateGruppe[]>('/gruppen', {}, cloudRoute());
  },

  /**
   * EINE Gruppe frisch vom Server.
   *
   * **Das ist der Aufruf, an dem die Aussperrung haengt.** Der Sendeweg ruft
   * ihn unmittelbar vor jeder Sendung (`krypto/gruppe/senden.ts`), weil es
   * kein Ereignis ueber einen Mitgliederwechsel gibt (nachgesehen, s.
   * `krypto/gruppe/sitzungswahl.ts`-Modulkopf). Ein zwischengespeicherter
   * Stand waere hier nicht eine Optimierung, sondern das Loch: dann
   * entschiede der Cache, wen man aussperrt.
   */
  lesen(gruppeId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe>(
      `/gruppen/${encodeURIComponent(gruppeId)}`,
      {},
      cloudRoute()
    );
  },

  erstellen(name: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe>('/gruppen', { method: 'POST', body: { name } }, cloudRoute());
  },

  mitgliedHinzufuegen(gruppeId: string, userId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe>(
      `/gruppen/${encodeURIComponent(gruppeId)}/mitglieder`,
      { method: 'POST', body: { user_id: userId } },
      cloudRoute()
    );
  },

  /** `null` in der Antwort heisst: die Gruppe wurde dabei aufgeloest (letztes
   *  Mitglied gegangen) — nicht „Fehler". */
  mitgliedEntfernen(gruppeId: string, userId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/mitglieder/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
      cloudRoute()
    );
  },

  verlassen(gruppeId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/verlassen`,
      { method: 'POST' },
      cloudRoute()
    );
  },

  /** Gruppenbild setzen (PNG/JPEG/WebP, max 5 MB — der Server skaliert auf
   *  256 px WebP). Antwort = die neue Gruppen-Wahrheit (wie bei den
   *  Mitglieds-Mutationen). */
  iconSetzen(gruppeId: string, file: File): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    const form = new FormData();
    form.append('file', file);
    return requestForm<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/icon`,
      form,
      {},
      cloudRoute()
    );
  },

  /** Gruppenbild entfernen — zurück zur Anfangsbuchstaben-Kachel. */
  iconEntfernen(gruppeId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/icon`,
      { method: 'DELETE' },
      cloudRoute()
    );
  },

  /** Gruppe umbenennen — OWNER allein (Rollen-Vertrag 2026-10-19). */
  umbenennen(gruppeId: string, name: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/name`,
      { method: 'PUT', body: { name } },
      cloudRoute()
    );
  },

  /** Gruppe AUFLÖSEN — Owner allein. 204 = für alle abgeräumt; der
   *  Aufrufer navigiert weg und nimmt sie aus dem Store. */
  async aufloesen(gruppeId: string): Promise<void> {
    if (!PRIVATE_GRUPPEN_ENABLED) return;
    await request<void>(`/gruppen/${encodeURIComponent(gruppeId)}`, { method: 'DELETE' }, cloudRoute());
  },

  /** Persönliche Stummschaltung umschalten (nur für das eigene Gerät/Geräte —
   *  das Handy-Push-Bein respektiert den Merker serverseitig). */
  async stummSetzen(gruppeId: string, stumm: boolean): Promise<void> {
    if (!PRIVATE_GRUPPEN_ENABLED) return;
    await request<void>(
      `/gruppen/${encodeURIComponent(gruppeId)}/stumm`,
      { method: 'POST', body: { stumm } },
      cloudRoute()
    );
  },

  /** Rolle eines Mitglieds setzen — Owner allein, nur „admin"/„mitglied"
   *  (der Owner wechselt über `besitzUebertragen`). 204; der neue Stand
   *  kommt über das Gruppen-Ereignis. */
  async rolleSetzen(
    gruppeId: string,
    userId: string,
    rolle: 'admin' | 'mitglied'
  ): Promise<void> {
    if (!PRIVATE_GRUPPEN_ENABLED) return;
    await request<void>(
      `/gruppen/${encodeURIComponent(gruppeId)}/mitglieder/${encodeURIComponent(userId)}/rolle`,
      { method: 'PUT', body: { rolle } },
      cloudRoute()
    );
  },

  /** Besitz übertragen — Owner allein. Das Ziel wird Owner, der bisherige
   *  Owner Admin. 204, Stand wie bei `rolleSetzen` über das Ereignis. */
  async besitzUebertragen(gruppeId: string, userId: string): Promise<void> {
    if (!PRIVATE_GRUPPEN_ENABLED) return;
    await request<void>(
      `/gruppen/${encodeURIComponent(gruppeId)}/besitz`,
      { method: 'POST', body: { user_id: userId } },
      cloudRoute()
    );
  },

  /** Nachricht anpinnen — der kanonische Anker der Nachricht (E2E). */
  anheften(gruppeId: string, anker: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/anheften`,
      { method: 'POST', body: { anker } },
      cloudRoute()
    );
  },

  /** Pin lösen. */
  anheftenLoesen(gruppeId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/anheften`,
      { method: 'DELETE' },
      cloudRoute()
    );
  }
};

/** Serverseitiger Lesefortschritt des Aufrufers in dieser Gruppe
 *  (Übergabe 05.10., Gruppen-Lesebestätigung). Fire-and-forget vom
 *  Leseweg — ein Fehlschlag kostet nur den blauen Haken, nie die Nachricht.
 *  Cloud-Route wie jede Gruppen-Anfrage: ohne sie ging die Meldung bei
 *  aktivem Self-Host an den Self-Host und verschwand dort im 404. */
export async function gruppenLesestandSetzen(
  gruppeId: string,
  lastReadMessageId: string,
  aktiv = false
): Promise<void> {
  await request<void>(
    // `aktiv`: s. `api/lesestand.ts` (Abfrage-Parameter, ein älterer Server übergeht ihn).
    `/gruppen/${encodeURIComponent(gruppeId)}/lesestand${aktiv ? '?aktiv=1' : ''}`,
    { method: 'PUT', body: { last_read_message_id: lastReadMessageId } },
    cloudRoute()
  );
}
