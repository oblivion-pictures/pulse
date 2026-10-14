/**
 * `web/static/install.sh` ohne Token (seit Oktober 2026).
 *
 * Bis dahin brach der Installer ohne `PULSE_BOOTSTRAP_TOKEN` sofort ab. Jetzt
 * braucht er nur die Adresse des Servers — aus `PULSE_HOSTNAME`, dem ersten
 * Argument oder einer Frage am Terminal — und verbindet den Server am Ende
 * per `pulse-connect` (s. `install-verbinden.test.ts`).
 *
 * **Wie das geht:** Hier läuft das ECHTE Skript von vorn bis zum Plan, mit
 * `--dry-run` (verändert nichts) und gefälschtem `docker`/`ss` auf dem PATH:
 * `docker info` gelingt, kein Container existiert, kein Port ist belegt.
 * `PULSE_TTY` zeigt auf eine Datei mit vorbereiteter Eingabe oder auf einen
 * Pfad, den es nicht gibt (= kein Terminal) — so wartet kein Lauf auf ein
 * echtes Terminal.
 */

import { test as testAlle } from 'node:test';

// Die Tests führen web/static/install.sh unter bash aus (gefälschte Kommandos
// über einen PATH-Ordner). Unter Windows geht das nicht kaputt-frei; der
// Installer gehört auf Linux-Hosts, die Prüfungen laufen in der Linux-CI.
const test = process.platform === 'win32' ? testAlle.skip : testAlle;
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

interface Lauf {
  exit: number;
  ausgabe: string;
  /** Das Konfigurationsverzeichnis dieses Laufs (PULSE_DIR). */
  pulseDir: string;
}

interface Optionen {
  env?: Record<string, string>;
  args?: string[];
  /** Inhalt des „Terminals"; `null` = es gibt keins. */
  eingabe?: string | null;
  /** Inhalt einer pulse.env aus einer früheren Installation. */
  alteKonfiguration?: string;
}

function lauf(optionen: Optionen = {}): Lauf {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-adresse-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
case "$1" in
  info|ps) exit 0 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'ss'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  chmodSync(join(bin, 'ss'), 0o755);

  const pulseDir = join(dir, 'pulse');
  if (optionen.alteKonfiguration !== undefined) {
    mkdirSync(pulseDir);
    writeFileSync(join(pulseDir, 'pulse.env'), optionen.alteKonfiguration, { mode: 0o600 });
  }
  let tty = join(dir, 'kein-terminal');
  if (optionen.eingabe != null) {
    tty = join(dir, 'terminal');
    writeFileSync(tty, optionen.eingabe);
  }

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    PULSE_DIR: pulseDir,
    PULSE_TTY: tty,
    ...(optionen.env ?? {})
  };
  try {
    const ausgabe = execFileSync('bash', [SKRIPT, '--dry-run', ...(optionen.args ?? [])], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { exit: 0, ausgabe, pulseDir };
  } catch (fehler) {
    const f = fehler as { status?: number; stdout?: string; stderr?: string };
    return { exit: f.status ?? 1, ausgabe: `${f.stdout ?? ''}${f.stderr ?? ''}`, pulseDir };
  }
}

test('ohne Token und mit PULSE_HOSTNAME läuft der Installer bis zum Plan', () => {
  const e = lauf({ env: { PULSE_HOSTNAME: 'chat.example.org' } });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /Server address: chat\.example\.org/);
  assert.match(e.ausgabe, /DRY RUN — nothing changed\./);
  assert.match(e.ausgabe, /ghcr\.io\/oblivion-pictures\/pulse:edge/);
  assert.doesNotMatch(e.ausgabe, /token/i);
});

test('die Adresse geht auch als erstes Argument', () => {
  const e = lauf({ args: ['chat.example.org'] });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /Server address: chat\.example\.org/);
});

test('ohne Adresse fragt der Installer am Terminal', () => {
  const e = lauf({ eingabe: 'Chat.Example.org\n' });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /Address of this server/);
  assert.match(e.ausgabe, /Server address: chat\.example\.org/);
});

test('ohne Adresse und ohne Terminal: klare Meldung statt Warten', () => {
  const e = lauf({ eingabe: null });
  assert.equal(e.exit, 1);
  assert.match(e.ausgabe, /No server address given/);
  assert.match(e.ausgabe, /PULSE_HOSTNAME=chat\.example\.org/);
});

test('die Adresse wird in die Form gebracht, die die Cloud einträgt', () => {
  for (const roh of ['https://Chat.Example.org:443/pfad', 'chat.example.org.', ' CHAT.example.org ']) {
    const e = lauf({ env: { PULSE_HOSTNAME: roh } });
    assert.equal(e.exit, 0, `${roh}: ${e.ausgabe}`);
    assert.match(e.ausgabe, /Server address: chat\.example\.org\n/, roh);
  }
});

test('ungültige Adressen werden abgewiesen, bevor etwas geschieht', () => {
  for (const roh of ['localhost', '203.0.113.7', 'chat_example.org', '-chat.example.org']) {
    const e = lauf({ env: { PULSE_HOSTNAME: roh } });
    assert.equal(e.exit, 1, roh);
    assert.match(e.ausgabe, /is not a valid server address/, roh);
    assert.doesNotMatch(e.ausgabe, /DRY RUN/, roh);
  }
});

test('ein alter Token-Befehl läuft weiter, der Token wird ignoriert und nicht ausgegeben', () => {
  const ueberEnv = lauf({
    env: { PULSE_HOSTNAME: 'chat.example.org', PULSE_BOOTSTRAP_TOKEN: 'plse_boot_geheimeswort' }
  });
  assert.equal(ueberEnv.exit, 0, ueberEnv.ausgabe);
  assert.match(ueberEnv.ausgabe, /Setup tokens are no longer needed/);
  assert.doesNotMatch(ueberEnv.ausgabe, /geheimeswort/);

  // Der alte Befehl `bash -s -- <TOKEN>`: das Argument ist KEINE Adresse.
  const alsArgument = lauf({
    env: { PULSE_HOSTNAME: 'chat.example.org' },
    args: ['plse_boot_geheimeswort']
  });
  assert.equal(alsArgument.exit, 0, alsArgument.ausgabe);
  assert.match(alsArgument.ausgabe, /Server address: chat\.example\.org/);
  assert.doesNotMatch(alsArgument.ausgabe, /geheimeswort/);
});

test('liegt eine frühere pulse.env da, ist ihre Adresse die Vorgabe', () => {
  const alt = 'PULSE_HOSTNAME=alt.example.org\nPULSE_INSTANCE_MODE=self-host\n';
  const mitTerminal = lauf({ eingabe: '\n', alteKonfiguration: alt });
  assert.equal(mitTerminal.exit, 0, mitTerminal.ausgabe);
  assert.match(mitTerminal.ausgabe, /Address of this server \[alt\.example\.org\]/);
  assert.match(mitTerminal.ausgabe, /Server address: alt\.example\.org/);

  const ohneTerminal = lauf({ eingabe: null, alteKonfiguration: alt });
  assert.equal(ohneTerminal.exit, 0, ohneTerminal.ausgabe);
  assert.match(ohneTerminal.ausgabe, /Server address: alt\.example\.org/);
});

test('der Dry-Run auf einer vorhandenen pulse.env nennt die Sicherung, legt sie aber nicht an', () => {
  const alt = 'PULSE_HOSTNAME=chat.example.org\nPULSE_PUBLIC_IP=203.0.113.7\nPULSE_LOG_LEVEL=warning\n';
  const e = lauf({ env: { PULSE_HOSTNAME: 'chat.example.org' }, alteKonfiguration: alt });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /Dry run: .*pulse\.env exists — a real run saves it as .*pulse\.env\.bak-\d+ before rewriting it/);
  assert.match(e.ausgabe, /Keeping PULSE_PUBLIC_IP from the previous configuration/);
  assert.match(e.ausgabe, /DRY RUN — nothing changed\./);
  assert.deepEqual(readdirSync(e.pulseDir), ['pulse.env'], 'der Dry-Run hat etwas angelegt');
  assert.equal(readFileSync(join(e.pulseDir, 'pulse.env'), 'utf8'), alt, 'der Dry-Run hat die Datei verändert');
});
