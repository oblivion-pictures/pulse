/**
 * `web/static/install.sh` — welches Bild ein erneuter Lauf nimmt (`waehle_bild`).
 *
 * Vorgabe ohne `PULSE_IMAGE` ist `ghcr.io/oblivion-pictures/pulse:stable`. Ein
 * erneuter Lauf auf einem Server, der schon läuft, darf ihn nicht still auf
 * diese Vorgabe umstellen: einzelne Server stehen bewusst auf
 * `:edge`, und die drei Bestandsserver ziehen vom Spiegel. Deshalb gilt, in
 * dieser Reihenfolge:
 *
 *   1. `PULSE_IMAGE` gewinnt immer;
 *   2. sonst das Bild des vorhandenen eigenen Containers, ersatzweise die
 *      `IMAGE=`-Zeile einer vorhandenen `pulse-update.sh`;
 *   3. ist das der Spiegel `registry.howispulse.com/pulse-allinone:<tag>` und
 *      kennt der Installer KEINE Zugangsdaten (aus `bestand_uebernehmen`),
 *      wird daraus `ghcr.io/oblivion-pictures/pulse:<derselbe tag>`; mit
 *      Zugangsdaten bleibt es beim Spiegel;
 *   4. ohne alles bleibt die Vorgabe.
 *
 * **Wie das geht:** `waehle_bild` und `ist_unser_container` werden heredoc-bewusst
 * aus `install.sh` geschnitten und gegen ein gefälschtes `docker` ausgeführt.
 * Dazu ein Durchlauf des echten Skripts mit `--dry-run`, damit auch die
 * Reihenfolge im Hauptablauf (Bild VOR `build_run_args`) festgehalten ist.
 */

import { test as testAlle } from 'node:test';

// Unter Windows nicht ausführbar (bash, PATH-Ordner mit gefälschten Befehlen).
const test = process.platform === 'win32' ? testAlle.skip : testAlle;
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

const VORGABE = 'ghcr.io/oblivion-pictures/pulse:stable';
const SPIEGEL_EDGE = 'registry.howispulse.com/pulse-allinone:edge';

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

interface Wahl {
  /** Das Bild des vorhandenen Containers; `null` = es gibt keinen. */
  container?: string | null;
  /** Inhalt einer vorhandenen pulse-update.sh; `undefined` = keine. */
  updater?: string;
  /** Hat der Installer Zugangsdaten (aus dem Bestand)? */
  zugang?: boolean;
  /** Ausdrücklich gesetztes PULSE_IMAGE. */
  pulseImage?: string;
}

interface Ergebnis {
  image: string;
  ausgabe: string;
}

function waehle(optionen: Wahl): Ergebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-bild-'));
  const container = optionen.container ?? null;
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$*" in
  *Config.Image*) ${container === null ? 'exit 1' : `echo '${container}'`} ;;
  *) ${container === null ? 'exit 1' : 'exit 0'} ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const updateSh = join(dir, 'pulse-update.sh');
  if (optionen.updater !== undefined) writeFileSync(updateSh, optionen.updater);

  const skript = `
set -euo pipefail
CONTAINER=pulse
IMAGE="\${PULSE_IMAGE:-${VORGABE}}"
UPDATE_SH="${updateSh}"
CLIENT_ID="${optionen.zugang ? 'cid' : ''}"
CLIENT_SECRET="${optionen.zugang ? 'geheim' : ''}"
log()  { printf 'LOG %s\\n' "$*"; }
${funktion(quelle, 'ist_unser_container')}
${funktion(quelle, 'waehle_bild')}
waehle_bild
echo "IMAGE=$IMAGE"
`;
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  delete env.PULSE_IMAGE;
  if (optionen.pulseImage) env.PULSE_IMAGE = optionen.pulseImage;
  const ausgabe = execFileSync('bash', ['-c', skript], { env, encoding: 'utf8' });
  const treffer = ausgabe.match(/^IMAGE=(.*)$/m);
  assert.ok(treffer, `keine IMAGE-Zeile: ${ausgabe}`);
  return { image: treffer[1], ausgabe };
}

test('kein Container, keine pulse-update.sh: es bleibt bei der Vorgabe :stable', () => {
  const e = waehle({});
  assert.equal(e.image, VORGABE);
  assert.doesNotMatch(e.ausgabe, /Keeping image|Using image/);
});

test('ein eigener Container auf ghcr :edge behält sein Bild', () => {
  const e = waehle({ container: 'ghcr.io/oblivion-pictures/pulse:edge' });
  assert.equal(e.image, 'ghcr.io/oblivion-pictures/pulse:edge');
  assert.match(e.ausgabe, /Keeping image ghcr\.io\/oblivion-pictures\/pulse:edge of the existing server/);
});

test('ein Bestandsserver auf dem Spiegel :edge bleibt dort, wenn er Zugangsdaten hat', () => {
  const e = waehle({ container: SPIEGEL_EDGE, zugang: true });
  assert.equal(e.image, SPIEGEL_EDGE);
  assert.match(e.ausgabe, /Keeping image registry\.howispulse\.com\/pulse-allinone:edge/);
});

test('ein Container auf dem Spiegel :edge ohne Zugangsdaten wechselt auf ghcr :edge', () => {
  const e = waehle({ container: SPIEGEL_EDGE, zugang: false });
  assert.equal(e.image, 'ghcr.io/oblivion-pictures/pulse:edge');
  assert.match(e.ausgabe, /Using image ghcr\.io\/oblivion-pictures\/pulse:edge/);
});

test('ohne Zugangsdaten bleibt der Tag des Spiegels erhalten, auch :stable', () => {
  const e = waehle({ container: 'registry.howispulse.com/pulse-allinone:stable' });
  assert.equal(e.image, 'ghcr.io/oblivion-pictures/pulse:stable');
});

test('ein Spiegel-Bild ohne lesbaren Tag (Digest, kein Tag) fällt auf die Vorgabe zurück', () => {
  for (const roh of [
    'registry.howispulse.com/pulse-allinone@sha256:0123456789abcdef',
    'registry.howispulse.com/pulse-allinone'
  ]) {
    assert.equal(waehle({ container: roh }).image, VORGABE, roh);
  }
});

test('PULSE_IMAGE gewinnt gegen den vorhandenen Container', () => {
  const e = waehle({
    container: 'ghcr.io/oblivion-pictures/pulse:edge',
    pulseImage: 'ghcr.io/oblivion-pictures/pulse:v1.2.3'
  });
  assert.equal(e.image, 'ghcr.io/oblivion-pictures/pulse:v1.2.3');
  assert.doesNotMatch(e.ausgabe, /Keeping image|Using image/);
});

test('ein fremder Container namens pulse wird nicht als Quelle des Bildes genommen', () => {
  const e = waehle({ container: 'postgres:16' });
  assert.equal(e.image, VORGABE);
});

test('ohne Container gilt die IMAGE-Zeile einer vorhandenen pulse-update.sh', () => {
  const e = waehle({
    updater: '#!/usr/bin/env bash\nset -euo pipefail\nIMAGE=ghcr.io/oblivion-pictures/pulse:edge\nCONTAINER=pulse\n'
  });
  assert.equal(e.image, 'ghcr.io/oblivion-pictures/pulse:edge');
  assert.match(e.ausgabe, /Keeping image ghcr\.io\/oblivion-pictures\/pulse:edge/);
});

test('die IMAGE-Zeile des Updaters folgt derselben Regel für den Spiegel', () => {
  const updater = `IMAGE=${SPIEGEL_EDGE}\n`;
  assert.equal(waehle({ updater, zugang: true }).image, SPIEGEL_EDGE);
  assert.equal(waehle({ updater, zugang: false }).image, 'ghcr.io/oblivion-pictures/pulse:edge');
});

test('der Container geht der pulse-update.sh vor', () => {
  const e = waehle({
    container: 'ghcr.io/oblivion-pictures/pulse:edge',
    updater: 'IMAGE=ghcr.io/oblivion-pictures/pulse:v9.9.9\n'
  });
  assert.equal(e.image, 'ghcr.io/oblivion-pictures/pulse:edge');
});

test('eine IMAGE-Zeile mit Sonderzeichen im Updater wird nicht übernommen', () => {
  const e = waehle({ updater: 'IMAGE=$\'evil\\ image\'\n' });
  assert.equal(e.image, VORGABE);
});

// --------------------------------------------------------------------- //
// Das echte Skript: Bild vor build_run_args
// --------------------------------------------------------------------- //

function dryRunMitContainer(image: string, alteKonfiguration?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-bild-lauf-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
case "$1" in
  info|ps) exit 0 ;;
  inspect)
    case "$*" in
      *Config.Image*) echo '${image}' ;;
      *State.Running*) echo true ;;
      *) exit 0 ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'ss'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  chmodSync(join(bin, 'ss'), 0o755);
  const pulseDir = join(dir, 'pulse');
  if (alteKonfiguration !== undefined) {
    mkdirSync(pulseDir);
    writeFileSync(join(pulseDir, 'pulse.env'), alteKonfiguration, { mode: 0o600 });
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    PULSE_DIR: pulseDir,
    PULSE_TTY: join(dir, 'kein-terminal'),
    PULSE_HOSTNAME: 'chat.example.org'
  };
  delete env.PULSE_IMAGE;
  return execFileSync('bash', [SKRIPT, '--dry-run'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('im Hauptablauf steht das beibehaltene Bild im geplanten docker run', () => {
  const ausgabe = dryRunMitContainer('ghcr.io/oblivion-pictures/pulse:edge');
  assert.match(ausgabe, /Keeping image ghcr\.io\/oblivion-pictures\/pulse:edge of the existing server/);
  const plan = ausgabe.split('\n').find((z) => z.includes('docker run'));
  assert.ok(plan, ausgabe);
  assert.match(plan, /ghcr\.io\/oblivion-pictures\/pulse:edge$/);
});

test('im Hauptablauf: Spiegel-Container mit Zugangsdaten in pulse.env bleibt auf dem Spiegel', () => {
  const alt = [
    'PULSE_HOSTNAME=chat.example.org',
    'PULSE_INSTANCE_ID=123456789',
    'PULSE_CLOUD_CLIENT_ID=cid-bestand',
    'PULSE_CLOUD_CLIENT_SECRET=geheimnis-bestand',
    ''
  ].join('\n');
  const ausgabe = dryRunMitContainer(SPIEGEL_EDGE, alt);
  const plan = ausgabe.split('\n').find((z) => z.includes('docker run'));
  assert.ok(plan, ausgabe);
  assert.match(plan, /registry\.howispulse\.com\/pulse-allinone:edge$/);
  assert.doesNotMatch(ausgabe, /geheimnis-bestand/);
});

test('im Hauptablauf: Spiegel-Container ohne Zugangsdaten läuft ohne Abbruch auf ghcr :edge weiter', () => {
  const ausgabe = dryRunMitContainer(SPIEGEL_EDGE);
  const plan = ausgabe.split('\n').find((z) => z.includes('docker run'));
  assert.ok(plan, ausgabe);
  assert.match(plan, /ghcr\.io\/oblivion-pictures\/pulse:edge$/);
  assert.match(ausgabe, /DRY RUN — nothing changed/);
});
