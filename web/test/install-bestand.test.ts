/**
 * `web/static/install.sh` — was in `pulse.env` und im Updater steht.
 *
 * Seit Oktober 2026 schreibt der Installer keine Zugangsdaten mehr: die holt
 * `pulse-connect` am Ende selbst ab und legt sie ins Datenvolumen. Eine
 * Ausnahme muss halten: die drei Server aus der Freigabe-Zeit tragen ihre
 * Zugangsdaten in `pulse.env`. Läuft der neue Installer auf so einem Server,
 * wandern sie mit — sonst stünde der Server unverbunden da, und ein neues
 * Verbinden gäbe ihm eine neue Instanz-Nummer (seine Mitglieder verlören ihn
 * aus ihrer Server-Liste). Ebenso bleibt beim Spiegel
 * `registry.howispulse.com` die Anmeldung im Updater; das öffentliche Bild
 * braucht keine.
 *
 * **Wie das geht:** wie in den Nachbardateien — die Funktionen werden
 * heredoc-bewusst aus `install.sh` geschnitten und gegen ein
 * Temp-Verzeichnis ausgeführt.
 */

import { test as testAlle } from 'node:test';

// Unter Windows nicht ausführbar (bash, chmod-Semantik); der Installer gehört
// auf Linux-Hosts, die Prüfungen laufen in der Linux-CI.
const test = process.platform === 'win32' ? testAlle.skip : testAlle;
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

/** Shell-Funktion bis zur `}` in Spalte 0 — heredoc-bewusst (wie install-updater.test.ts). */
function funktion(quelle: string, name: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `Funktion ${name}() nicht gefunden — Skript umgebaut?`);
  let heredocEnde: string | null = null;
  for (let i = start + 1; i < zeilen.length; i++) {
    const zeile = zeilen[i];
    if (heredocEnde !== null) {
      if (zeile === heredocEnde) heredocEnde = null;
      continue;
    }
    const treffer = zeile.match(/<<-?\s*['"]?(\w+)['"]?\s*$/);
    if (treffer) {
      heredocEnde = treffer[1];
      continue;
    }
    if (zeile === '}') return zeilen.slice(start, i + 1).join('\n');
  }
  assert.fail(`kein Ende fuer ${name}() gefunden — Skript umgebaut?`);
}

const BESTAND = [
  'PULSE_HOSTNAME=chat.example.org',
  'PULSE_INSTANCE_ID=123456789',
  'PULSE_INSTANCE_OWNER_ID=987654321',
  'PULSE_INSTANCE_MODE=self-host',
  'PULSE_CLOUD_ORIGIN=https://howispulse.com',
  'PULSE_CLOUD_CLIENT_ID=cid-bestand',
  'PULSE_CLOUD_CLIENT_SECRET=geheimnis-bestand',
  'PULSE_ADMIN_EMAIL=alt@example.org',
  'PULSE_TLS_MODE=auto',
  'PULSE_HTTP_PORT=8080',
  ''
].join('\n');

interface Konfig {
  datei: string;
  modus: number;
  ausgabe: string;
}

function konfiguriere(opt: { alteDatei?: string; adminEmail?: string } = {}): Konfig {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-konfig-'));
  const pulseDir = join(dir, 'pulse');
  if (opt.alteDatei !== undefined) {
    mkdirSync(pulseDir);
    writeFileSync(join(pulseDir, 'pulse.env'), opt.alteDatei, { mode: 0o600 });
  }
  const skript = `
set -euo pipefail
PULSE_DIR="${pulseDir}"
ENV_FILE="${join(pulseDir, 'pulse.env')}"
SRV_HOST=chat.example.org
CLOUD_ORIGIN=https://howispulse.com
ADMIN_EMAIL="${opt.adminEmail ?? ''}"
TLS_MODE=auto
HTTP_PORT=8080
INSTANCE_ID=""; CLIENT_ID=""; CLIENT_SECRET=""; BESTAND_ZEILEN=""
log()  { printf 'LOG %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*"; }
${funktion(quelle, 'zugang_lesen')}
${funktion(quelle, 'bestand_uebernehmen')}
${funktion(quelle, 'schreibe_konfiguration')}
bestand_uebernehmen
schreibe_konfiguration
printf 'VAR INSTANCE_ID=%s\\n' "$INSTANCE_ID"
printf 'VAR CLIENT_ID=%s\\n' "$CLIENT_ID"
printf 'VAR SECRET_GESETZT=%s\\n' "\${CLIENT_SECRET:+ja}"
`;
  const ausgabe = execFileSync('bash', ['-c', skript], { encoding: 'utf8' });
  const pfad = join(pulseDir, 'pulse.env');
  return { datei: readFileSync(pfad, 'utf8'), modus: statSync(pfad).mode & 0o777, ausgabe };
}

test('eine Neuinstallation schreibt keine Zugangsdaten in pulse.env', () => {
  const k = konfiguriere();
  assert.match(k.datei, /^PULSE_HOSTNAME=chat\.example\.org$/m);
  assert.match(k.datei, /^PULSE_INSTANCE_MODE=self-host$/m);
  assert.match(k.datei, /^PULSE_CLOUD_ORIGIN=https:\/\/howispulse\.com$/m);
  assert.match(k.datei, /^PULSE_TLS_MODE=auto$/m);
  assert.match(k.datei, /^PULSE_HTTP_PORT=8080$/m);
  assert.doesNotMatch(k.datei, /PULSE_INSTANCE_ID|PULSE_INSTANCE_OWNER_ID|PULSE_CLOUD_CLIENT/);
  assert.doesNotMatch(k.datei, /PULSE_ADMIN_EMAIL/, 'ohne Angabe keine leere Mail-Zeile');
  assert.equal(k.modus, 0o600);
});

test('PULSE_ADMIN_EMAIL steht nur drin, wenn sie angegeben wurde', () => {
  const k = konfiguriere({ adminEmail: 'admin@example.org' });
  assert.match(k.datei, /^PULSE_ADMIN_EMAIL=admin@example\.org$/m);
});

test('ein Bestandsserver behält seine Verbindung, ohne dass das Geheimnis ausgegeben wird', () => {
  const k = konfiguriere({ alteDatei: BESTAND });
  for (const zeile of [
    'PULSE_INSTANCE_ID=123456789',
    'PULSE_INSTANCE_OWNER_ID=987654321',
    'PULSE_CLOUD_CLIENT_ID=cid-bestand',
    'PULSE_CLOUD_CLIENT_SECRET=geheimnis-bestand',
    'PULSE_ADMIN_EMAIL=alt@example.org'
  ]) {
    assert.ok(k.datei.split('\n').includes(zeile), `fehlt in pulse.env: ${zeile}`);
  }
  assert.match(k.ausgabe, /Keeping the existing connection of chat\.example\.org \(instance 123456789\)/);
  assert.match(k.ausgabe, /^VAR CLIENT_ID=cid-bestand$/m);
  assert.match(k.ausgabe, /^VAR SECRET_GESETZT=ja$/m);
  assert.doesNotMatch(k.ausgabe, /geheimnis-bestand/);
});

test('gehört die alte pulse.env zu einer anderen Adresse, wandert nichts mit', () => {
  const k = konfiguriere({ alteDatei: BESTAND.replace('chat.example.org', 'alt.example.org') });
  assert.match(k.ausgabe, /WARN The previous configuration .* belongs to alt\.example\.org/);
  assert.doesNotMatch(k.datei, /PULSE_INSTANCE_ID|PULSE_CLOUD_CLIENT/);
  assert.match(k.ausgabe, /^VAR INSTANCE_ID=$/m);
});

function registryPruefung(image: string, mitZugang: boolean): { exit: number; ausgabe: string } {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const skript = `
set -euo pipefail
IMAGE="${image}"
CLIENT_ID="${mitZugang ? 'cid' : ''}"
CLIENT_SECRET="${mitZugang ? 'geheim' : ''}"
err() { printf '%s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
${funktion(quelle, 'pruefe_registry_zugang')}
pruefe_registry_zugang
echo __WEITER__
`;
  try {
    return { exit: 0, ausgabe: execFileSync('bash', ['-c', skript], { encoding: 'utf8' }) };
  } catch (fehler) {
    const f = fehler as { status?: number; stderr?: string };
    return { exit: f.status ?? 1, ausgabe: f.stderr ?? '' };
  }
}

test('der Spiegel registry.howispulse.com ohne Bestands-Zugang bricht ab, bevor etwas geschieht', () => {
  const e = registryPruefung('registry.howispulse.com/pulse-allinone:edge', false);
  assert.equal(e.exit, 1);
  assert.match(e.ausgabe, /unset PULSE_IMAGE/);
  assert.match(e.ausgabe, /Nothing has been changed yet/);
});

test('der Spiegel mit Bestands-Zugang und das öffentliche Bild laufen weiter', () => {
  assert.equal(registryPruefung('registry.howispulse.com/pulse-allinone:edge', true).exit, 0);
  assert.equal(registryPruefung('ghcr.io/oblivion-pictures/pulse:stable', false).exit, 0);
});

function updater(image: string, clientId: string, secret: string): { text: string; modus: number } {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-updater-anmeldung-'));
  const updateSh = join(dir, 'pulse-update.sh');
  const skript = `
set -euo pipefail
PULSE_DIR="${dir}"
UPDATE_SH="${updateSh}"
IMAGE="${image}"
CONTAINER=pulse
CLIENT_ID="${clientId}"
CLIENT_SECRET="${secret}"
RUN_ARGS=( -d --name pulse "${image}" )
${funktion(quelle, 'write_update_script')}
write_update_script
`;
  execFileSync('bash', ['-c', skript], { encoding: 'utf8' });
  return { text: readFileSync(updateSh, 'utf8'), modus: statSync(updateSh).mode & 0o777 };
}

test('der Updater für das öffentliche Bild meldet sich nirgends an', () => {
  const u = updater('ghcr.io/oblivion-pictures/pulse:stable', '', '');
  assert.doesNotMatch(u.text, /^REGISTRY=/m);
  assert.doesNotMatch(u.text, /^REG_USER=/m);
  assert.doesNotMatch(u.text, /^REG_PASS=/m);
});

test('ein Bestandsserver am Spiegel behält die Anmeldung im Updater', () => {
  const u = updater('registry.howispulse.com/pulse-allinone:edge', 'cid-bestand', 'geheimnis-bestand');
  assert.match(u.text, /^REGISTRY=registry\.howispulse\.com$/m);
  assert.match(u.text, /^REG_USER=cid-bestand$/m);
  assert.match(u.text, /^REG_PASS=geheimnis-bestand$/m);
  assert.equal(u.modus, 0o700);
});
