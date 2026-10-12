/**
 * Server umbenennen — wer darf, und was ist zu speichern. Reine Rechnung,
 * importfrei (prüfbar mit `pnpm test:unit`, Muster wie `erstellrecht.ts`).
 *
 * Der Name eines Self-Hosts gehört dem Server (`chat_settings.instance_name`)
 * und wird mit der Sitzung bei DIESEM Server gespeichert (`PATCH
 * /admin/permissions`) — nicht über die Cloud. Die Cloud bekommt ihn vom Server
 * gemeldet und reicht ihn an die Mitglieder weiter, die den Server noch nie
 * geöffnet haben.
 */

/** Wie `PermissionsPatch.instance_name` im chat-gateway (`schemas.py`). */
export const SERVER_NAME_MAX = 60;

export type UmbenennenEingaben = {
  /** Die Cloud lässt sich nicht umbenennen — ihr Name ist fest. */
  istCloud: boolean;
  /** Rolle laut Cloud-Serverliste (`GET /me/instances`, `role`). */
  rolleLautCloud: 'owner' | 'member' | null;
  /**
   * `is_admin` aus dem `ready`-Rahmen DIESES Servers, oder `null`, wenn er noch
   * nichts gemeldet hat. `null` und `false` sind verschiedene Dinge (wie in
   * `erstellrecht.ts`): „noch nicht gefragt“ ist kein „nein“.
   */
  adminLautServer: boolean | null;
};

/**
 * **Die Auskunft des Servers gewinnt, sobald es eine gibt** — er entscheidet
 * die Anfrage am Ende ohnehin (nur Admins dürfen `PATCH /admin/permissions`).
 * Davor genügt die Cloud-Angabe „du bist der Besitzer“, damit ein Betreiber den
 * Eintrag auch auf einem Server sieht, mit dem die App noch nicht verbunden
 * ist. Ausdrücklich NICHT das Cloud-Plattform-Flag `auth.user.is_admin`: wer
 * die Cloud verwaltet, verwaltet damit keinen fremden Server.
 */
export function darfServerUmbenennen(e: UmbenennenEingaben): boolean {
  if (e.istCloud) return false;
  return e.adminLautServer ?? e.rolleLautCloud === 'owner';
}

/**
 * Was beim Speichern an den Server geht. `null` = nichts zu tun (Name
 * unverändert). Leer heißt „zurück zur Adresse“ und geht als leere
 * Zeichenkette hinaus — `null` hieße im Server „Feld nicht ändern“.
 */
export function zuSpeichernderName(eingabe: string, aktuell: string | null): string | null {
  const neu = eingabe.trim().slice(0, SERVER_NAME_MAX);
  return neu === (aktuell ?? '').trim() ? null : neu;
}
