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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs';
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
  pulseDir: string;
  /** Sicherungskopien der pulse.env im Konfigurationsverzeichnis. */
  sicherungen: string[];
}

interface KonfigOptionen {
  alteDatei?: string;
  /** Modus der vorhandenen pulse.env (Vorgabe 600). */
  alterModus?: number;
  adminEmail?: string;
  /** Wie `--dry-run`: lesen und melden, aber `schreibe_konfiguration` nicht aufrufen. */
  dryRun?: boolean;
  /** Adresse dieses Laufs (Vorgabe chat.example.org). */
  host?: string;
}

function konfiguriere(opt: KonfigOptionen = {}): Konfig {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-konfig-'));
  const pulseDir = join(dir, 'pulse');
  const pfad = join(pulseDir, 'pulse.env');
  if (opt.alteDatei !== undefined) {
    mkdirSync(pulseDir);
    writeFileSync(pfad, opt.alteDatei, { mode: opt.alterModus ?? 0o600 });
    chmodSync(pfad, opt.alterModus ?? 0o600);
  }
  const skript = `
set -euo pipefail
PULSE_DIR="${pulseDir}"
ENV_FILE="${pfad}"
SRV_HOST=${opt.host ?? 'chat.example.org'}
CLOUD_ORIGIN=https://howispulse.com
ADMIN_EMAIL="${opt.adminEmail ?? ''}"
TLS_MODE=auto
HTTP_PORT=8080
VOLUME=pulse-data
DRY_RUN="${opt.dryRun ? '1' : ''}"
INSTANCE_ID=""; CLIENT_ID=""; CLIENT_SECRET=""; BESTAND_ZEILEN=""
ZUSATZ_ZEILEN=""; ENV_SICHERUNG=""; ALTE_ADRESSE=""
log()  { printf 'LOG %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*"; }
die()  { printf 'DIE %s\\n' "$*"; exit 1; }
${funktion(quelle, 'zugang_lesen')}
${funktion(quelle, 'zusatz_uebernehmen')}
${funktion(quelle, 'bestand_uebernehmen')}
${funktion(quelle, 'schreibe_konfiguration')}
bestand_uebernehmen
if [ -z "$DRY_RUN" ]; then schreibe_konfiguration; fi
printf 'VAR INSTANCE_ID=%s\\n' "$INSTANCE_ID"
printf 'VAR CLIENT_ID=%s\\n' "$CLIENT_ID"
printf 'VAR SECRET_GESETZT=%s\\n' "\${CLIENT_SECRET:+ja}"
printf 'VAR ALTE_ADRESSE=%s\\n' "$ALTE_ADRESSE"
`;
  const ausgabe = execFileSync('bash', ['-c', skript], { encoding: 'utf8' });
  const sicherungen = existsSync(pulseDir)
    ? readdirSync(pulseDir).filter((n) => n.startsWith('pulse.env.bak-')).sort()
    : [];
  return {
    datei: existsSync(pfad) ? readFileSync(pfad, 'utf8') : '',
    modus: existsSync(pfad) ? statSync(pfad).mode & 0o777 : 0,
    ausgabe,
    pulseDir,
    sicherungen
  };
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

test('gehört die alte pulse.env zu einer anderen Adresse, sagt die Warnung, was mit der Verbindung geschieht', () => {
  const k = konfiguriere({ alteDatei: BESTAND.replace('chat.example.org', 'alt.example.org') });
  const warnung = k.ausgabe
    .split('\n')
    .filter((z) => z.startsWith('WARN '))
    .join(' ');
  // Werte aus der Datei wandern nicht mit, die Datei selbst bleibt als Sicherung erhalten …
  assert.match(warnung, /not carried over/);
  assert.ok(warnung.includes(`${k.pulseDir}/${k.sicherungen[0]}`), `Pfad der Sicherung fehlt: ${warnung}`);
  // … und eine im Datenvolumen gespeicherte Verbindung bleibt, gilt aber der ALTEN Adresse.
  assert.match(warnung, /volume 'pulse-data'/);
  assert.match(warnung, /still belongs to alt\.example\.org/);
  assert.doesNotMatch(warnung, /connection is not carried over\./, 'alte, zu knappe Formulierung');
  assert.match(k.ausgabe, /^VAR ALTE_ADRESSE=alt\.example\.org$/m);
});

test('gleiche Adresse: kein Merker für eine alte Adresse', () => {
  const k = konfiguriere({ alteDatei: BESTAND });
  assert.match(k.ausgabe, /^VAR ALTE_ADRESSE=$/m);
});

// --------------------------------------------------------------------- //
// Sicherung der vorhandenen pulse.env
// --------------------------------------------------------------------- //

test('eine vorhandene pulse.env wird vor dem Überschreiben gesichert (cp -p, Modus 600)', () => {
  const k = konfiguriere({ alteDatei: BESTAND, alterModus: 0o644 });
  assert.equal(k.sicherungen.length, 1, `Sicherungen: ${k.sicherungen.join(', ')}`);
  assert.match(k.sicherungen[0], /^pulse\.env\.bak-\d+$/);
  const kopie = join(k.pulseDir, k.sicherungen[0]);
  assert.equal(readFileSync(kopie, 'utf8'), BESTAND, 'die Kopie ist nicht die alte Datei');
  assert.equal(statSync(kopie).mode & 0o777, 0o600, 'die Kopie trägt Zugangsdaten und muss 600 sein');
  assert.ok(k.ausgabe.includes(kopie), `die Meldung nennt den Pfad der Kopie nicht:\n${k.ausgabe}`);
  assert.equal(k.modus, 0o600);
});

test('die Sicherung hält fest, was die neue Datei nicht mehr trägt (andere Adresse)', () => {
  const alt = BESTAND.replace('chat.example.org', 'alt.example.org');
  const k = konfiguriere({ alteDatei: alt });
  assert.doesNotMatch(k.datei, /PULSE_CLOUD_CLIENT_SECRET/);
  const kopie = readFileSync(join(k.pulseDir, k.sicherungen[0]), 'utf8');
  assert.match(kopie, /^PULSE_CLOUD_CLIENT_SECRET=geheimnis-bestand$/m);
  assert.doesNotMatch(k.ausgabe, /geheimnis-bestand/, 'das Geheimnis stand in der Ausgabe');
});

test('eine Neuinstallation legt keine Sicherung an', () => {
  const k = konfiguriere();
  assert.deepEqual(k.sicherungen, []);
  assert.doesNotMatch(k.ausgabe, /\.bak-/);
});

test('ein Dry-Run legt keine Sicherung an, nennt sie aber', () => {
  const k = konfiguriere({ alteDatei: BESTAND, dryRun: true });
  assert.deepEqual(k.sicherungen, [], 'der Dry-Run hat eine Datei angelegt');
  assert.equal(k.datei, BESTAND, 'der Dry-Run hat die pulse.env verändert');
  assert.match(k.ausgabe, /LOG Dry run: .*pulse\.env exists .*saves it as .*pulse\.env\.bak-\d+/);
});

test('kann die Sicherung nicht angelegt werden, bleibt die alte pulse.env unberührt', () => {
  // Ein Ziel in einem Verzeichnis, das es nicht gibt, lässt cp zuverlässig scheitern, ohne root vorauszusetzen.
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-sicherung-fehlt-'));
  const pfad = join(dir, 'pulse.env');
  writeFileSync(pfad, BESTAND, { mode: 0o600 });
  const sperre = join(dir, 'gibt-es-nicht', 'pulse.env.bak-1234567890');
  const skript = `
set -euo pipefail
PULSE_DIR="${dir}"
ENV_FILE="${pfad}"
ENV_SICHERUNG="${sperre}"
SRV_HOST=chat.example.org
CLOUD_ORIGIN=https://howispulse.com
ADMIN_EMAIL=""; TLS_MODE=auto; HTTP_PORT=8080; BESTAND_ZEILEN=""; ZUSATZ_ZEILEN=""
log()  { printf 'LOG %s\\n' "$*"; }
die()  { printf 'DIE %s\\n' "$*"; exit 1; }
${funktion(quelle, 'schreibe_konfiguration')}
schreibe_konfiguration
`;
  let ausgabe = '';
  let exit = 0;
  try {
    ausgabe = execFileSync('bash', ['-c', skript], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (fehler) {
    const f = fehler as { status?: number; stdout?: string };
    exit = f.status ?? 1;
    ausgabe = f.stdout ?? '';
  }
  assert.equal(exit, 1, ausgabe);
  assert.match(ausgabe, /DIE Could not save/);
  assert.equal(readFileSync(pfad, 'utf8'), BESTAND, 'die alte Datei wurde trotz fehlender Sicherung überschrieben');
});

// --------------------------------------------------------------------- //
// Bekannte Zusatzzeilen bleiben beim Neulauf erhalten
// --------------------------------------------------------------------- //

const NEUER_SERVER = [
  'PULSE_HOSTNAME=chat.example.org',
  'PULSE_INSTANCE_MODE=self-host',
  'PULSE_CLOUD_ORIGIN=https://howispulse.com',
  'PULSE_ADMIN_EMAIL=betreiber@example.org',
  'PULSE_PUBLIC_IP=203.0.113.7',
  'PULSE_LOG_LEVEL=warning',
  'PULSE_BACKUP_RETENTION=14',
  'PULSE_BACKUP_INTERVAL_SECONDS=3600',
  'PULSE_TLS_MODE=auto',
  'PULSE_HTTP_PORT=8080',
  ''
].join('\n');

test('ein Neulauf übernimmt bekannte Zusatzzeilen aus der vorhandenen pulse.env', () => {
  // Ein Server, den dieser Installer eingerichtet hat: keine Verbindungszeilen
  // (die liegen im Volumen), aber vom Betreiber von Hand ergänzte Schalter.
  const k = konfiguriere({ alteDatei: NEUER_SERVER });
  for (const zeile of [
    'PULSE_ADMIN_EMAIL=betreiber@example.org',
    'PULSE_PUBLIC_IP=203.0.113.7',
    'PULSE_LOG_LEVEL=warning',
    'PULSE_BACKUP_RETENTION=14',
    'PULSE_BACKUP_INTERVAL_SECONDS=3600'
  ]) {
    assert.equal(
      k.datei.split('\n').filter((z) => z === zeile).length,
      1,
      `${zeile} muss genau einmal in der neuen pulse.env stehen:\n${k.datei}`
    );
  }
  assert.doesNotMatch(k.datei, /PULSE_INSTANCE_ID|PULSE_CLOUD_CLIENT/, 'keine Verbindungszeilen erfunden');
});

test('die E-Mail-Adresse aus der Umgebung gewinnt gegen die der alten Datei', () => {
  const k = konfiguriere({ alteDatei: NEUER_SERVER, adminEmail: 'neu@example.org' });
  assert.match(k.datei, /^PULSE_ADMIN_EMAIL=neu@example\.org$/m);
  assert.doesNotMatch(k.datei, /betreiber@example\.org/);
});

test('Zusatzzeilen reisen auch bei geänderter Adresse mit, die Verbindung nicht', () => {
  const k = konfiguriere({ alteDatei: NEUER_SERVER.replace('chat.example.org', 'alt.example.org') });
  assert.match(k.datei, /^PULSE_PUBLIC_IP=203\.0\.113\.7$/m);
  assert.match(k.datei, /^PULSE_LOG_LEVEL=warning$/m);
});

test('nur die Allowlist wird übernommen, nichts Unbekanntes und nichts mit Sonderzeichen', () => {
  const alt = [
    'PULSE_HOSTNAME=chat.example.org',
    'PULSE_TLS_MODE=behind-proxy',
    'PULSE_RELAY_TUNNEL_TOKEN=plse_relay_geheim',
    'FOO=bar',
    'PULSE_LOG_LEVEL=info; rm -rf /',
    'PULSE_BACKUP_DISABLED=true',
    'PULSE_BACKUP_X Y=1',
    'PULSE_PUBLIC_IP=',
    ''
  ].join('\n');
  const k = konfiguriere({ alteDatei: alt });
  assert.match(k.datei, /^PULSE_BACKUP_DISABLED=true$/m);
  assert.doesNotMatch(k.datei, /PULSE_RELAY_TUNNEL_TOKEN|FOO=|rm -rf|BACKUP_X|PULSE_PUBLIC_IP/);
  // PULSE_TLS_MODE kommt immer aus dem neuen Lauf, nie aus der alten Datei.
  assert.match(k.datei, /^PULSE_TLS_MODE=auto$/m);
  assert.doesNotMatch(k.datei, /behind-proxy/);
  // Ein verworfener Wert wird beim Namen genannt, nie mit seinem Wert.
  assert.match(k.ausgabe, /WARN Ignoring PULSE_LOG_LEVEL/);
  assert.doesNotMatch(k.ausgabe, /rm -rf/);
  assert.doesNotMatch(k.ausgabe, /plse_relay_geheim/);
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
  // Der Spiegel nimmt die Zugangsdaten jeder aktiven Instanz an; die Meldung
  // darf nicht behaupten, er sei Servern aus der Freigabe-Zeit vorbehalten.
  assert.doesNotMatch(e.ausgabe, /before October 2026/);
  assert.match(e.ausgabe, /only knows them from the pulse\.env of an existing server/);
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
