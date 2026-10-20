/**
 * Sicherheitsnetz für den offenen Kanal: kam zu einem Bump die Nachricht
 * nicht an, wird sie nachgeholt.
 *
 * **Warum es das braucht.** Für einen abonnierten (offenen) Kanal bekommt der
 * Klient jede Nachricht zweimal angekündigt: als `message` mit Inhalt und als
 * `channel_bump`/`dm_bump` ohne Inhalt. Bis 2026-10-21 setzte der Bump für
 * einen offenen Kanal nur den Lesestand — ging das `message`-Ereignis
 * verloren (Abo am Server weg, Socket still verworfen, Wettlauf beim
 * Neuaufbau), blieb das unsichtbar: kein Ungelesen-Zähler, keine Zeile,
 * nichts bis zum nächsten Neuladen. Der Bump ist der Beweis, dass es eine
 * Nachricht gibt; fehlt sie nach der Frist in der Anzeige, holt das Netz den
 * Kanal per REST nach.
 *
 * Bumps gibt der Server nur auf dem Klartext-Weg aus (`ws_op_send.py`,
 * `messages.py`, `system_dm.py`), mit der ID, unter der die Nachricht auch im
 * `message`-Ereignis steht. Verschlüsselte Nachrichten kündigt `postfach_neu`
 * an, nie ein Bump — eine abweichende Anzeige-ID kann hier also nicht
 * auslösen.
 *
 * Entprellt je Kanal: alle Bumps innerhalb der Frist landen in EINER Prüfung,
 * und die holt höchstens einmal nach. Importfrei (Test: `nachhol-netz`); die
 * Verdrahtung steht in `handlers/nachholNetz.ts`.
 */
import type { Planer } from './nachholTakt.ts';

export type BumpWache = {
  /** Ein Bump für einen offenen Kanal ist eingetroffen. `serverId` = der
   *  Server der Verbindung, über die er kam (für den REST-Abruf). */
  melden(kanalId: string, nachrichtId: string, serverId: string): void;
};

export function bumpWacheErzeugen(o: {
  liegtVor: (kanalId: string, nachrichtId: string) => boolean;
  nachholen: (kanalId: string, serverId: string) => void;
  fristMs: number;
  planer: Planer;
}): BumpWache {
  const offen = new Map<string, { ids: Set<string>; serverId: string }>();
  return {
    melden(kanalId, nachrichtId, serverId) {
      const laufend = offen.get(kanalId);
      if (laufend) {
        laufend.ids.add(nachrichtId);
        laufend.serverId = serverId;
        return;
      }
      const eintrag = { ids: new Set([nachrichtId]), serverId };
      offen.set(kanalId, eintrag);
      o.planer.planen(() => {
        offen.delete(kanalId);
        for (const id of eintrag.ids) {
          if (!o.liegtVor(kanalId, id)) {
            o.nachholen(kanalId, eintrag.serverId);
            return;
          }
        }
      }, o.fristMs);
    }
  };
}
