/**
 * `web/static/install.sh` — der letzte Schritt: den Server mit einem
 * Pulse-Konto verbinden (`server_verbinden`, Spec E1/E6).
 *
 * Der Installer ruft `docker exec -it <container> pulse-connect --no-restart`
 * mit dem Terminal als Eingabe auf (bei `curl … | bash` ist stdin die Pipe),
 * startet danach selbst neu und wartet, bis der Server mit den abgeholten
 * Zugangsdaten wieder steht. Was hier festgehalten wird:
 *
 *   - pulse-connect bekommt das Terminal, nicht die Pipe;
 *   - jedes Scheitern (Strg+C, abgelehnt, abgelaufen, von aussen nicht
 *     erreichbar, kein Terminal) endet mit dem Hinweis
 *     `Connect later: docker exec -it pulse pulse-connect` und OHNE
 *     Fehler-Exit — der Server läuft ja;
 *   - ein schon verbundener Server (Neuinstallation auf altem Volumen,
 *     Bestandsserver) wird nicht neu verbunden: pulse-connect fragte dort
 *     nach, ob er einem anderen Konto gehören soll;
 *   - das Client-Secret für die Prüfung aus der Cloud geht nie über die
 *     Befehlszeile (`ps`), sondern über stdin an curl.
 *
 * **Wie das geht:** die Funktionen werden heredoc-bewusst aus `install.sh`
 * geschnitten und gegen ein gefälschtes `docker`/`curl` ausgeführt, die jeden
 * Aufruf samt Herkunft ihrer Standardeingabe protokollieren
 * (`/proc/self/fd/0` — Linux, wie der ganze Installer).
 */

import { test as testAlle } from 'node:test';

// Nur unter Linux ausführbar: das falsche `docker` liest `/proc/self/fd/0`,
// das es unter Windows (dazu ohne bash) und macOS nicht gibt — dort blieb die
// Herkunft leer, und „stdin war nicht das Terminal" färbte das Gate auf jedem
// Mac rot (bis 2026-10-19 stand hier nur `win32`). Der Installer gehört auf
// Linux-Hosts, die Prüfungen laufen in der Linux-CI.
const test = process.platform === 'linux' ? testAlle : testAlle.skip;
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
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

/** Wörtlicher Ausschnitt zwischen zwei Zeilen (beide inklusive, getrimmt verglichen). */
function bereich(quelle: string, vonZeile: string, bisZeile: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.trim() === vonZeile);
  assert.notEqual(start, -1, `Startanker "${vonZeile}" nicht gefunden — Skript umgebaut?`);
  const ende = zeilen.findIndex((z, i) => i > start && z.trim() === bisZeile);
  assert.notEqual(ende, -1, `Endanker "${bisZeile}" nicht gefunden — Skript umgebaut?`);
  return zeilen.slice(start, ende + 1).join('\n');
}

interface Optionen {
  /** Antwort von pulse-server-info im Container; `null` = er antwortet nicht. */
  serverInfo: string | null;
  /** Exit-Code von pulse-connect. */
  connectExit?: number;
  /** Gibt es ein Terminal? */
  terminal?: boolean;
  /** Die Adresse, auf die die vorige pulse.env lief (`bestand_uebernehmen`), wenn sie nicht diese ist. */
  alteAdresse?: string;
  /** Stehen die Verbindungswerte in der pulse.env (Bestandsserver)? */
  bestand?: boolean;
  /** Ab dem wievielten Aufruf meldet pulse-health die Dienste als bereit? Vorgabe: ab dem ersten. */
  diensteAbVersuch?: number;
}

interface Ergebnis {
  exit: number;
  ausgabe: string;
  /** Jeder docker-Aufruf als Zeile „<argumente> | stdin=<herkunft>". */
  dockerAufrufe: string[];
  terminalPfad: string;
}

function umgebung(optionen: Optionen) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-verbinden-'));
  const protokoll = join(dir, 'docker.log');
  writeFileSync(protokoll, '');
  const zaehler = join(dir, 'pulse-health.n');
  const terminalPfad = join(dir, 'terminal');
  if (optionen.terminal !== false) writeFileSync(terminalPfad, '');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
printf '%s | stdin=%s\\n' "$*" "$(readlink /proc/self/fd/0)" >> "${protokoll}"
case "$*" in
  *pulse-server-info*) ${
    optionen.serverInfo === null ? 'exit 7' : `printf '%s' '${optionen.serverInfo}'`
  } ;;
  *pulse-connect*) exit ${optionen.connectExit ?? 0} ;;
  *pulse-health*)
    n=$(( $(cat "${zaehler}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${zaehler}"
    [ "$n" -ge ${optionen.diensteAbVersuch ?? 1} ] && exit 0
    exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);
  return { dir, protokoll, terminalPfad };
}

const VORSPANN = `
set -euo pipefail
CONTAINER=pulse
VERBUNDEN=""
SRV_HOST=chat.example.org
ENV_FILE=/opt/pulse/pulse.env
PULSE_INSTALL_WARTE_VERSUCHE=1
PULSE_INSTALL_WARTE_INTERVALL=0
log()  { printf 'LOG %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*"; }
warte_auf_start() { echo __GEWARTET__; }
`;

function verbinde(optionen: Optionen): Ergebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const u = umgebung(optionen);
  const skript = `${VORSPANN}
TTY_GERAET="${u.terminalPfad}"
ALTE_ADRESSE="${optionen.alteAdresse ?? ''}"
BESTAND_ZEILEN="${optionen.bestand ? 'PULSE_INSTANCE_ID=123456789' : ''}"
${funktion(quelle, 'server_info_innen')}
${funktion(quelle, 'ist_verbunden')}
${funktion(quelle, 'verbinden_spaeter')}
${funktion(quelle, 'server_verbinden')}
server_verbinden
echo "VERBUNDEN=$VERBUNDEN"
echo __UEBERLEBT__
`;
  let exit = 0;
  let ausgabe = '';
  try {
    ausgabe = execFileSync('bash', ['-c', skript], {
      env: { ...process.env, PATH: `${u.dir}:${process.env.PATH}` },
      encoding: 'utf8'
    });
  } catch (fehler) {
    const f = fehler as { status?: number; stdout?: string };
    exit = f.status ?? 1;
    ausgabe = f.stdout ?? '';
  }
  const dockerAufrufe = readFileSync(u.protokoll, 'utf8').split('\n').filter(Boolean);
  return { exit, ausgabe, dockerAufrufe, terminalPfad: u.terminalPfad };
}

const UNVERBUNDEN = '{"server_version":"0.8.0","instance_id":null,"verbunden":false}';
const VERBUNDEN = '{"server_version":"0.8.0","instance_id":"123456789","verbunden":true}';
const HINWEIS = /Connect later: docker exec -it pulse pulse-connect/;

test('pulse-connect läuft mit --no-restart und dem Terminal als Eingabe, danach Neustart', () => {
  const e = verbinde({ serverInfo: UNVERBUNDEN, connectExit: 0 });
  assert.equal(e.exit, 0, e.ausgabe);
  const connect = e.dockerAufrufe.find((z) => z.includes('pulse-connect'));
  assert.ok(connect, `pulse-connect nicht aufgerufen: ${e.dockerAufrufe.join('\n')}`);
  assert.match(connect, /^exec -it pulse pulse-connect --no-restart \| /);
  assert.ok(connect.endsWith(`stdin=${e.terminalPfad}`), `stdin war nicht das Terminal: ${connect}`);
  assert.ok(e.dockerAufrufe.some((z) => z.startsWith('restart pulse ')), 'kein docker restart');
  assert.match(e.ausgabe, /__GEWARTET__/);
  assert.match(e.ausgabe, /^VERBUNDEN=1$/m);
  assert.doesNotMatch(e.ausgabe, HINWEIS);
});

test('Abbruch von pulse-connect (Strg+C) → Hinweis, kein Neustart, kein Fehler-Exit', () => {
  const e = verbinde({ serverInfo: UNVERBUNDEN, connectExit: 130 });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /__UEBERLEBT__/);
  assert.match(e.ausgabe, HINWEIS);
  assert.ok(!e.dockerAufrufe.some((z) => z.startsWith('restart ')), 'trotz Abbruch neu gestartet');
  assert.match(e.ausgabe, /^VERBUNDEN=$/m);
});

test('abgelehnt/abgelaufen (2), Fehler (1) und von aussen nicht erreichbar (3) enden ebenso', () => {
  for (const code of [1, 2, 3]) {
    const e = verbinde({ serverInfo: UNVERBUNDEN, connectExit: code });
    assert.equal(e.exit, 0, `Exit ${code}: ${e.ausgabe}`);
    assert.match(e.ausgabe, HINWEIS, `Exit ${code}`);
    assert.ok(!e.dockerAufrufe.some((z) => z.startsWith('restart ')), `Exit ${code}: neu gestartet`);
  }
});

test('Neuinstallation auf altem, schon verbundenem Volumen: kein neues Verbinden', () => {
  const e = verbinde({ serverInfo: VERBUNDEN });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')), 'pulse-connect aufgerufen');
  assert.ok(!e.dockerAufrufe.some((z) => z.startsWith('restart ')), 'neu gestartet');
  assert.match(e.ausgabe, /already connected to a Pulse account/);
  assert.match(e.ausgabe, /To connect it to a different account:  docker exec -it pulse pulse-connect/);
  assert.match(e.ausgabe, /^VERBUNDEN=1$/m);
});

test('ein Bestandsserver (Verbindung in pulse.env) bekommt nicht den Rat, pulse-connect für ein anderes Konto zu rufen', () => {
  // pulse-connect weist Server mit Verbindungswerten aus der Umgebung ab (Exit 1).
  const e = verbinde({ serverInfo: VERBUNDEN, bestand: true });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /already connected to a Pulse account/);
  assert.doesNotMatch(e.ausgabe, /To connect it to a different account/);
  assert.match(e.ausgabe, /stored in \/opt\/pulse\/pulse\.env, so pulse-connect refuses to change it/);
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')));
  assert.match(e.ausgabe, /^VERBUNDEN=1$/m);
});

test('Adresswechsel auf einem im Volumen verbundenen Server: nicht „fertig“, sondern der Weg zur neuen Adresse', () => {
  // Die Verbindung liegt im Datenvolumen und gilt der alten Adresse; der
  // Cloud-Eintrag trägt sie noch. „Already connected“ wäre hier die falsche Auskunft.
  const e = verbinde({ serverInfo: VERBUNDEN, alteAdresse: 'alt.example.org' });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.doesNotMatch(e.ausgabe, /already connected/i);
  assert.match(e.ausgabe, /still has its old address, alt\.example\.org/);
  assert.match(e.ausgabe, /To enter chat\.example\.org .*docker exec -it pulse pulse-connect/);
  assert.match(e.ausgabe, /asks before changing anything/);
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')), 'pulse-connect darf nicht ungefragt laufen');
  assert.ok(!e.dockerAufrufe.some((z) => z.startsWith('restart ')));
  // Die Prüfung von aussen (nur bei VERBUNDEN) ginge gegen die alte Adresse im Cloud-Eintrag.
  assert.match(e.ausgabe, /^VERBUNDEN=$/m);
});

test('Adresswechsel auf einem noch nicht verbundenen Server: ganz normal verbinden', () => {
  const e = verbinde({ serverInfo: UNVERBUNDEN, connectExit: 0, alteAdresse: 'alt.example.org' });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.ok(e.dockerAufrufe.some((z) => z.includes('pulse-connect')));
  assert.match(e.ausgabe, /^VERBUNDEN=1$/m);
  assert.doesNotMatch(e.ausgabe, /old address/);
});

test('ein älterer Server ohne Feld „verbunden", aber mit Instanz-Nummer gilt als verbunden', () => {
  const e = verbinde({ serverInfo: '{"server_version":"0.7.0","instance_id":"123456789"}' });
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')));
  assert.match(e.ausgabe, /^VERBUNDEN=1$/m);
});

test('ohne Terminal kein pulse-connect, sondern der Hinweis', () => {
  const e = verbinde({ serverInfo: UNVERBUNDEN, terminal: false });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')));
  assert.match(e.ausgabe, HINWEIS);
});

test('antwortet der Server im Container nicht, wird nicht verbunden', () => {
  const e = verbinde({ serverInfo: null });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')));
  assert.match(e.ausgabe, HINWEIS);
});

test('antwortet der Server nicht, behauptet die Meldung nicht zugleich, er laufe', () => {
  const e = verbinde({ serverInfo: null });
  assert.match(e.ausgabe, /does not answer inside the container/);
  assert.doesNotMatch(e.ausgabe, /is running/, 'widerspricht „antwortet nicht“');
  assert.match(e.ausgabe, /It is not connected to a Pulse account yet\./);
  // Gegenprobe: dort, wo der Server tatsächlich antwortet, bleibt der Satz stehen.
  const e2 = verbinde({ serverInfo: UNVERBUNDEN, connectExit: 2 });
  assert.match(e2.ausgabe, /Your server is running, but it is not connected to a Pulse account yet/);
});

test('der Hauptablauf endet nach gescheitertem Verbinden mit Exit 0 und „Done."', () => {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const u = umgebung({ serverInfo: UNVERBUNDEN, connectExit: 2 });
  const skript = `${VORSPANN}
TTY_GERAET="${u.terminalPfad}"
ALTE_ADRESSE=""
BESTAND_ZEILEN=""
pruefung_von_aussen() { return 1; }
${funktion(quelle, 'server_info_innen')}
${funktion(quelle, 'ist_verbunden')}
${funktion(quelle, 'verbinden_spaeter')}
${funktion(quelle, 'warte_auf_dienste')}
${funktion(quelle, 'server_verbinden')}
${bereich(quelle, 'server_verbinden', 'log "Done."')}
`;
  const ausgabe = execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${u.dir}:${process.env.PATH}` },
    encoding: 'utf8'
  });
  assert.match(ausgabe, HINWEIS);
  assert.match(ausgabe, /LOG Done\./);
  assert.doesNotMatch(ausgabe, /Checking your server from the outside/, 'Cloud-Prüfung ohne Verbindung');
  assert.ok(
    !readFileSync(u.protokoll, 'utf8').includes('pulse-health'),
    'ohne Verbindung gibt es keine Prüfung, also auch nichts abzuwarten'
  );
});

/**
 * Hauptablauf ab Schritt 8 bis „Done.": `warte_auf_start` und die Prüfung aus
 * der Cloud schreiben sich ins docker-Protokoll, damit die Reihenfolge prüfbar ist.
 */
function hauptablauf(optionen: Optionen, versuche = 1) {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const u = umgebung(optionen);
  const skript = `${VORSPANN}
PULSE_INSTALL_WARTE_VERSUCHE=${versuche}
TTY_GERAET="${u.terminalPfad}"
ALTE_ADRESSE=""
BESTAND_ZEILEN=""
warte_auf_start() { echo "__warte_auf_start__" >> "${u.protokoll}"; }
pruefung_von_aussen() { echo "__pruefung_von_aussen__" >> "${u.protokoll}"; }
${funktion(quelle, 'server_info_innen')}
${funktion(quelle, 'ist_verbunden')}
${funktion(quelle, 'verbinden_spaeter')}
${funktion(quelle, 'warte_auf_dienste')}
${funktion(quelle, 'server_verbinden')}
${bereich(quelle, 'server_verbinden', 'log "Done."')}
`;
  const ausgabe = execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${u.dir}:${process.env.PATH}` },
    encoding: 'utf8'
  });
  const aufrufe = readFileSync(u.protokoll, 'utf8').split('\n').filter(Boolean);
  const stelle = (anfang: string) => aufrufe.findIndex((z) => z.startsWith(anfang));
  return { ausgabe, aufrufe, stelle };
}

test('nach dem Neustart wartet der Installer auf die Dienste, bevor er von aussen prüft', () => {
  // Ohne dieses Warten traf die Prüfung aus der Cloud auf einen Server, dessen
  // HTTP-Dienste noch nicht antworteten (Probe auf dem Hetzner-Rechner).
  const e = hauptablauf({ serverInfo: UNVERBUNDEN, connectExit: 0 });
  const neustart = e.stelle('restart pulse ');
  const gestartet = e.stelle('__warte_auf_start__');
  const gesund = e.stelle('exec pulse pulse-health ');
  const pruefung = e.stelle('__pruefung_von_aussen__');
  assert.notEqual(neustart, -1, `kein Neustart: ${e.aufrufe.join('\n')}`);
  assert.notEqual(gesund, -1, `pulse-health nicht gefragt: ${e.aufrufe.join('\n')}`);
  assert.notEqual(pruefung, -1, 'keine Prüfung von aussen');
  assert.ok(neustart < gestartet && gestartet < gesund && gesund < pruefung, e.aufrufe.join('\n'));
  assert.doesNotMatch(e.ausgabe, /has not finished starting/);
  assert.match(e.ausgabe, /LOG Done\./);
});

test('meldet pulse-health erst beim zweiten Mal bereit, wird erneut gefragt und nicht gewarnt', () => {
  const e = hauptablauf({ serverInfo: UNVERBUNDEN, connectExit: 0, diensteAbVersuch: 2 }, 3);
  assert.equal(e.aufrufe.filter((z) => z.startsWith('exec pulse pulse-health ')).length, 2);
  assert.doesNotMatch(e.ausgabe, /has not finished starting/);
  assert.ok(e.stelle('__pruefung_von_aussen__') !== -1, 'keine Prüfung von aussen');
});

test('kommen die Dienste nicht hoch: Warnung mit pulse-doctor, die Prüfung läuft trotzdem, Exit 0', () => {
  const e = hauptablauf({ serverInfo: UNVERBUNDEN, connectExit: 0, diensteAbVersuch: 99 }, 2);
  assert.equal(e.aufrufe.filter((z) => z.startsWith('exec pulse pulse-health ')).length, 2);
  assert.match(e.ausgabe, /^WARN Pulse has not finished starting all its services/m);
  assert.match(e.ausgabe, /docker exec pulse pulse-doctor/);
  assert.ok(e.stelle('__pruefung_von_aussen__') !== -1, 'keine Prüfung von aussen');
  assert.match(e.ausgabe, /LOG Done\./);
});

test('ein schon verbundener Server wird vor der Prüfung ebenso abgewartet, ohne Neustart', () => {
  const e = hauptablauf({ serverInfo: VERBUNDEN });
  assert.equal(e.stelle('restart pulse '), -1, 'Neustart ohne neues Verbinden');
  assert.ok(e.stelle('exec pulse pulse-health ') !== -1, e.aufrufe.join('\n'));
  assert.ok(e.stelle('exec pulse pulse-health ') < e.stelle('__pruefung_von_aussen__'));
});

test('die Prüfung aus der Cloud liest die Zugangsdaten aus dem Volumen und gibt das Secret nie auf der Befehlszeile weiter', () => {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-pruefung-'));
  const argvLog = join(dir, 'curl-argv.log');
  const stdinLog = join(dir, 'curl-stdin.log');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$*" in
  *verbindung.env*) printf 'PULSE_INSTANCE_ID=123456789\\nPULSE_INSTANCE_OWNER_ID=42\\nPULSE_CLOUD_CLIENT_ID=cid-neu\\nPULSE_CLOUD_CLIENT_SECRET=geheimnis-neu\\n' ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/bash
printf '%s\\n' "$*" > "${argvLog}"
cat > "${stdinLog}"
printf '{"gesamt":"ok","schritte":[]}'
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'curl'), 0o755);
  const skript = `
set -euo pipefail
CONTAINER=pulse
CLOUD_ORIGIN=https://cloud.invalid
INSTANCE_ID=""; CLIENT_ID=""; CLIENT_SECRET=""
PY_BERICHT='import sys; print("BERICHT " + sys.stdin.read())'
${funktion(quelle, 'zugang_lesen')}
${funktion(quelle, 'zugang_aus_volumen')}
${funktion(quelle, 'pruefung_von_aussen')}
pruefung_von_aussen
`;
  const ausgabe = execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8'
  });
  assert.match(ausgabe, /BERICHT \{"gesamt":"ok"/);
  assert.ok(existsSync(argvLog), 'curl wurde nicht aufgerufen');
  const argv = readFileSync(argvLog, 'utf8');
  assert.match(argv, /\/api\/auth\/selfhost\/diagnose\/123456789/);
  assert.doesNotMatch(argv, /geheimnis-neu/, 'Secret stand auf der Befehlszeile');
  const stdin = readFileSync(stdinLog, 'utf8');
  assert.match(stdin, /X-Pulse-Client-Secret: geheimnis-neu/);
  assert.match(stdin, /X-Pulse-Client-Id: cid-neu/);
  assert.doesNotMatch(ausgabe, /geheimnis-neu/);
});
