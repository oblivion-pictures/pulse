/**
 * Datenbank und Redis-DB der E2E-Suite — die EINE Quelle, wie `_ports.ts` für
 * die Ports.
 *
 * Wer parallel fährt (mehrere Arbeitskopien oder Agenten teilen sich Postgres
 * und Redis), verschiebt die Suite mit `PULSE_E2E_DB` / `PULSE_E2E_REDIS_DB`;
 * sonst löscht das TRUNCATE des einen Laufs die Nutzer mitten im Lauf des
 * anderen. Ohne die Variablen gelten die Vorgaben `dcc_test` und `/1`.
 *
 * **Eine Spec, die Postgres direkt anfasst (Gegenprobe per `psql`, Admin-
 * Beförderung per `UPDATE`), nimmt `E2E_DB` von hier und trägt `dcc_test`
 * nicht selbst ein.** Ein fester Name fällt mit der Vorgabe nie auf und
 * schreibt unter einer eigenen Datenbank still in die falsche: der Befehl
 * gelingt (die Datenbank gibt es ja), er trifft nur keine Zeile — die
 * Admin-Beförderung bleibt wirkungslos, und der Test scheitert erst viel
 * später an einer fehlenden Oberfläche.
 */

const wert = (name: string, vorgabe: string): string => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? vorgabe : raw;
};

const datenbank = (name: string, vorgabe: string): string => {
  const db = wert(name, vorgabe);
  // Der Name wird unquotiert in Shell-Befehle und SQL (`CREATE DATABASE`)
  // eingesetzt. Lautes Scheitern statt eines Befehls, der anders endet als
  // gemeint — dieselbe Haltung wie bei den Ports.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(db)) {
    throw new Error(`${name}="${db}" ist kein Datenbankname (erlaubt: Buchstaben, Ziffern, _).`);
  }
  return db;
};

const redisDb = (name: string, vorgabe: number): number => {
  const raw = wert(name, String(vorgabe));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name}="${raw}" ist keine Redis-Datenbanknummer.`);
  }
  return n;
};

export const E2E_DB = datenbank('PULSE_E2E_DB', 'dcc_test');
export const E2E_REDIS_DB = redisDb('PULSE_E2E_REDIS_DB', 1);
