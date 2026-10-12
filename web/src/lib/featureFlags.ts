/**
 * Zentrale Feature-Flags (Build-Zeit-Konstanten).
 *
 * Bewusst KEINE Server-/Env-Steuerung — diese Flags blenden Features aus, die
 * noch nicht end-to-end fertig sind, damit User sie nicht „entdecken" und etwas
 * anfragen, das nicht funktioniert. Zum Wieder-Einschalten: auf `true` setzen.
 */

/**
 * Kanäle mit eigener Ablage: verschlüsselte Textkanäle, deren Bytes als Log
 * im eigenen Cloud-Speicher des Owners liegen (Dropbox/Drive/OneDrive/
 * Nextcloud/Sync-Ordner).
 *
 * Konzept: `docs/user-gehostete-kanaele-konzept.md`. Gebaut ist laut
 * Bau-Variante 2 (§6a) nur die krypto-freie Speicher-Hälfte.
 *
 * **AN seit dem 2026-09-01.** Die Bedingung, unter der er zu war, ist
 * eingelöst: der Krypto-Nachzug ist gelandet (Etappe E6). Ein Klartext-Log im
 * privaten Cloud-Konto des Owners wäre der Scan-/Haftungswall aus
 * `docs/user-gehostete-kanaele-analyse.md` (Wand 3) — genau deshalb weist der
 * Server seit B1 einen Klartext-Post in einen Ablage-Kanal ab, und der
 * Nachweis dafür ist eine eigene Prüfung
 * (`tests/e2e/e2e-ablage-kanal.spec.ts`, „die Umkehrung").
 *
 * **Ohne verbundenes Laufwerk gibt es den Kanal-Typ nicht** — der Schalter
 * macht ihn nur wählbar, er ersetzt keine Cloud.
 */
export const ABLAGE_KANAL_ENABLED = true;
