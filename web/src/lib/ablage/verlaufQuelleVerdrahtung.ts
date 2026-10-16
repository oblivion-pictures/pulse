/**
 * Verdrahtet `verlaufQuelle.ts` mit Postfach und Verlaufs-Datenbank — die
 * Zeile, die die importfreie Quelle ihrem Aufrufer überlässt. Löst
 * `postfachQuelleVerdrahtung.ts` ab (bis 2026-10-17).
 *
 * **Keine Konto-Sperre mehr.** Die Vorgängerin öffnete Gruppennachrichten
 * selbst (`oeffneGruppennachricht`) und musste das unter `mitKontosperre`
 * tun, weil eingehende Megolm-Sitzungen nur unter dieser Sperre ratchen
 * dürfen (`gruppenSitzungen.ts`, Modulkopf). Diese Quelle öffnet nichts: sie
 * liest abgelegte Sätze und den offenen Bestand, und `abholen` verändert am
 * Server nichts (`routes/postfach_abholen.py`: „Abholen loescht nicht").
 * Damit gibt es neben dem Abholzyklus keine zweite Stelle mehr, die an einer
 * eingehenden Sitzung dreht.
 */
import { postfachApi } from '../api/postfach';
import { serversStore } from '../api/servers.svelte';
import { geraeteKennung } from '../krypto/geraeteKennung';
import { aktuellesKonto } from '../verlauf/konto';
import { clockSync } from '../watch/clockSync';
import { verlaufSaetzeAufsteigend } from '../verlauf/dbAufsteigend';
import { festigbar, verlaufQuelle } from './verlaufQuelle';
import type { NachzieherQuelle } from './nachzieher';

/** Dieselbe Cloud-Route wie `krypto/empfangen.ts`: DMs, Gruppen und
 *  Ablage-Kanäle haben ihr Postfach nur in der Cloud (`api/postfach.ts`). */
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Die produktive `NachzieherQuelle` für den Ablage-Kanal `kanalId`. */
export function verlaufQuelleFuerKanal(kanalId: string): NachzieherQuelle {
  return verlaufQuelle(
    kanalId,
    async () => postfachApi.abholen({ device_pubkey: await geraeteKennung() }, cloudRoute()),
    (nach, bis, limit) => {
      const konto = aktuellesKonto();
      // Ohne Konto keine Sätze — und kein stilles „leer": die Festigung
      // meldet den Fehlschlag und versucht es nach dem Backoff erneut.
      if (konto === null) throw new Error('Festigung ohne angemeldetes Konto');
      return verlaufSaetzeAufsteigend(
        kanalId,
        nach === null ? null : nach.toString(),
        bis.toString(),
        limit,
        festigbar,
        konto
      );
    },
    // Die Server-Uhr, nicht die eigene — Snowflakes tragen jene
    // (`verlaufQuelle.ts`, „Reifezeit").
    () => clockSync.now()
  );
}
