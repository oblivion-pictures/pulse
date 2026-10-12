/**
 * API-Client der Self-Host-Instanzen (auth-svc).
 *
 * Alle User-Endpoints nutzen Cookie-Auth (pulse_session HttpOnly) via
 * credentials:'include'. Admin-Endpoints ebenfalls — auth-svc prüft
 * is_admin server-seitig.
 *
 * Wichtig: RotateSecretResult.client_secret NIE in console.log/localStorage/
 * sessionStorage speichern — nur transient im UI anzeigen.
 *
 * Antrag, Freigabe und `.env`-Download sind seit 2026-10 aus der Oberfläche
 * entfernt (Spec 2026-10-09-selfhost-ohne-freigabe-design.md, E11): ein neuer
 * Server verbindet sich über `pulse-connect` und die Seite `/verbinden`
 * (`api/verbinden.ts`).
 *
 * Backend-Quelle:
 *   routes_instance_applications.py (User: /me/instances …)
 *   routes_admin_instances.py       (Admin)
 */

import { cookieFetch } from './cookie-client';

type InstanceStatus = 'active' | 'suspended';

/** Spiegelt InstanceOut (User-Route, kein client_secret). */
export interface Instance {
  id: string;
  hostname: string;
  client_id: string;
  /** Snowflake-Worker-Nummern; `null` bei Einträgen seit 2026-10 (Spec E7). */
  worker_id_chat: number | null;
  worker_id_voice: number | null;
  worker_id_media: number | null;
  status: InstanceStatus;
  /** vps = gemieteter Server mit eigener Adresse, app_host = Heim-Server (Server-App). */
  origin: 'vps' | 'app_host';
  /** Selbst verbunden (`pulse-connect`, Spec E1) statt vom Admin freigegeben. */
  ohne_freigabe: boolean;
  registered_at: string;
  /** Geräteübergreifender Notification-Modus aus der Membership (account-basiert).
   *  (Das Backend führt zusätzlich ein dormantes ``user_label`` — der
   *  persönliche Server-Name wurde entfernt; den Namen bestimmt der Admin.) */
  notification_mode: 'all' | 'mentions' | 'none';
  /** Eigene Rolle auf dieser Instanz. Die Liste enthält AUCH Server, denen man
   *  nur beigetreten ist (damit sie auf allen Geräten in der Server-Leiste
   *  stehen) — nur `owner` darf löschen und sieht „Meine Server“. */
  role: 'owner' | 'member';
  /** Sind die Zugangsdaten dieses Servers schon abgeholt (Installer bzw.
   *  `pulse-connect`, Server-App)? Erst dann nimmt `serversStore` ihn in die
   *  Server-Leiste auf. Optional, weil ein älterer Cloud-Stand das Feld noch
   *  nicht schickt; wird dort wie `true` behandelt (s. `hydrateFromBackend`). */
  set_up?: boolean;
  /** Vom Betreiber vergebener Name (der Server meldet ihn der Cloud) —
   *  `null` = keiner. Optional: ältere Cloud schickt das Feld nicht. */
  anzeigename?: string | null;
  /** Nur Heim-Server (`app_host`): läuft er? `null` = unbekannt (VPS). */
  online?: boolean | null;
  /** Fristende (ISO) eines Übernahme-Antrags, den ein ANDERES Konto für diese
   *  Adresse gestellt hat (Widerspruchsfrist, Spec 2026-10-09 Nachtrag
   *  2026-10-11). Nur am eigenen Eintrag gesetzt, solange ein lebendiger Antrag
   *  vorliegt; sonst `null`. Optional, weil eine ältere Cloud das Feld nicht
   *  schickt — dort gilt es wie `null`. */
  uebernahme_frist_bis?: string | null;
}

/** Spiegelt InstanceOut (Admin-Route — trägt registrar_username). */
export interface AdminInstance {
  id: string;
  hostname: string;
  client_id: string;
  worker_id_chat: number | null;
  worker_id_voice: number | null;
  worker_id_media: number | null;
  /** `deleted` kommt nur in der Liste `status=suspended` vor: eine gesperrte
   *  Instanz, die ihr Besitzer gelöscht hat und die ihre Adresse weiter hält. */
  status: 'active' | 'suspended' | 'deleted';
  registered_at: string;
  registrar_username: string;
  origin: 'vps' | 'app_host';
  /** Selbst verbunden statt freigegeben — kein „Secret rotieren“ (Spec §5). */
  ohne_freigabe: boolean;
}

/** Spiegelt RotateSecretOut. */
export interface RotateSecretResult {
  instance_id: string;
  client_secret: string;
  warning: string;
}

/** Ein Glied der Kette (spiegelt SchrittAus in routes_selfhost_diagnose.py).
 *
 *  `titel`, `was_ist` und `was_tun` kommen FERTIG vom Server
 *  (`dcc_auth/diagnose_texte.py`) und werden hier nur noch angezeigt. Der
 *  Grund steht dort: dieselben Sätze erscheinen im Installer-Terminal, und
 *  zwei Kataloge beschrieben denselben Zustand nach kurzer Zeit verschieden.
 *  `befund` bleibt der maschinenlesbare Schlüssel — für Tests und Protokolle. */
interface DiagnoseSchritt {
  schritt: string;
  ok: boolean;
  befund: string;
  einzelheit: string | null;
  titel: string;
  was_ist: string;
  /** Leer, wenn der Schritt sitzt. */
  was_tun: string;
}

/** Spiegelt DiagnoseAus. `gesamt` ist 'ok' oder der Name des ERSTEN Schritts,
 *  der nicht sass — nicht des letzten: alles danach ist Folge, nicht Ursache. */
export interface DiagnoseErgebnis {
  hostname: string;
  gesamt: string;
  schritte: DiagnoseSchritt[];
  /** Glieder, die wegen eines früheren Fehlschlags gar nicht geprüft wurden.
   *  Müssen sichtbar bleiben — sonst liest sich eine abgebrochene Kette wie
   *  eine vollständige. */
  nicht_geprueft: string[];
}

// ---------------------------------------------------------------------------
// User-Endpoints (/me/*)
// ---------------------------------------------------------------------------

export const instancesApi = {
  /** Eigene und beigetretene Instanzen (kein client_secret). */
  listMyInstances(): Promise<Instance[]> {
    return cookieFetch<Instance[]>('/me/instances');
  },

  /**
   * Membership auf einer Self-Host-Instanz in der Cloud eintragen — macht den
   * per Einladung beigetretenen Server auch auf anderen Geräten (Browser)
   * sichtbar. Idempotent; vom Client NUR nach erfolgreichem Ticket-Login
   * aufgerufen. Owner-Rolle wird nie herabgestuft.
   */
  joinInstanceMembership(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/membership`, { method: 'POST' });
  },

  /**
   * Cloud-Membership wieder entfernen, wenn der User den Server entfernt
   * (austritt). 403 für den Owner (der bleibt Mitglied). Idempotent.
   */
  leaveInstanceMembership(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/membership`, { method: 'DELETE' });
  },

  /**
   * Geräteübergreifenden Notification-Modus setzen, damit Stummschalten auf
   * allen Geräten gilt (nicht nur lokal). Das Backend akzeptiert weiterhin ein
   * dormantes ``label`` (persönlicher Server-Name entfernt) — der Client sendet
   * es nicht mehr.
   */
  updateInstancePreferences(
    instanceId: string,
    prefs: { notification_mode?: 'all' | 'mentions' | 'none' }
  ): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/preferences`, {
      method: 'PATCH',
      body: prefs
    });
  },

  /**
   * Erreichbarkeitsprüfung von aussen: die Cloud geht die ganze Kette ab
   * (DNS, TCP, Zertifikat, /health, Identität, CORS, WebSocket-Upgrade, UDP)
   * und benennt das Glied, das fehlt. Das ist das Einzige, was der Server über
   * sich selbst nicht sagen kann.
   *
   * Dauert bis zu 40 s (der Server deckelt), deshalb ein eigener Zeitrahmen im
   * Aufrufer statt eines Spinners ins Blaue.
   */
  diagnose(instanceId: string): Promise<DiagnoseErgebnis> {
    return cookieFetch<DiagnoseErgebnis>(`/selfhost/diagnose/${instanceId}`, {
      method: 'POST'
    });
  },

  /**
   * Widerspruch gegen einen Übernahme-Antrag eines anderen Kontos (Widerspruchsfrist,
   * Spec 2026-10-09 Nachtrag 2026-10-11). 204 = der Antrag ist erledigt und die
   * Adresse für fremde Konten gesperrt. Fehler kommen als `ApiError`:
   * 404 (kein eigener Eintrag oder kein lebendiger Antrag), 409
   * `widerspruch_ohne_server` (unter der Adresse antwortet nicht mehr dieser
   * Server), 503 `verbinden_ausgelastet`, 429, 401 — gedeutet in
   * `selfhost/widerspruch.ts`.
   */
  widersprechen(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/uebernahme/widerspruch`, {
      method: 'POST'
    });
  },

  /**
   * Eigene Instanz löschen (Soft-Delete, irreversibel). Die Adresse wird
   * wieder frei, außer der Server war gesperrt — dann bleibt sie gesperrt, bis
   * der Admin sie freigibt. Ein noch laufender Server landet auf der
   * Sperrliste und stellt den Betrieb ein.
   */
  deleteMyInstance(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}`, { method: 'DELETE' });
  }
};

// ---------------------------------------------------------------------------
// Admin-Endpoints (/admin/*)
// ---------------------------------------------------------------------------

export const adminInstancesApi = {
  /** Registrierte Instanzen auflisten. */
  listInstances(status: 'all' | 'active' | 'suspended' = 'all'): Promise<AdminInstance[]> {
    return cookieFetch<AdminInstance[]>(`/admin/instances?status=${status}`);
  },

  /** Instanz suspendieren (soft-delete). */
  suspendInstance(instanceId: string, reason?: string): Promise<void> {
    const qs = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return cookieFetch<void>(`/admin/instances/${instanceId}${qs}`, { method: 'DELETE' });
  },

  /** Instanz entsperren; bei einer gelöschten (`status: 'deleted'`) gibt derselbe
   *  Aufruf nur die Adresse frei, die Instanz bleibt gelöscht. */
  unsuspendInstance(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/admin/instances/${instanceId}/unsuspend`, { method: 'POST' });
  },

  /** Secret rotieren — gibt client_secret EINMALIG zurück. */
  rotateSecret(instanceId: string): Promise<RotateSecretResult> {
    return cookieFetch<RotateSecretResult>(`/admin/instances/${instanceId}/rotate-secret`, {
      method: 'POST'
    });
  }
};
