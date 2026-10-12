/**
 * `web/static/install.sh` — die Frage nach der Proxy-Route (Schritt 6) und was
 * Strg+C dort kostet.
 *
 * Hinter einem eigenen Reverse-Proxy bittet der Installer um EINE Route und
 * wartet auf Enter. Der Verbindungsschritt (Schritt 8, `server_verbinden`)
 * kommt erst danach. Bricht der Betreiber an dieser Frage mit Strg+C ab, endet
 * der Installer — und der Server bliebe unverbunden, ohne dass je etwas darauf
 * hinwiese. Früher stand dort „Last step“ und „(or Ctrl-C to check later)“,
 * beides falsch: es ist nicht der letzte Schritt, und „später prüfen“ ist nicht
 * das, was fehlt. Festgehalten wird:
 *
 *   - Die Frage nennt den Befehl zum Verbinden selbst (`pulse-connect`).
 *   - Strg+C gibt genau diesen Hinweis noch einmal aus und beendet mit 130.
 *   - Der Trap gilt nur für das Warten: danach ist er wieder abgenommen.
 *
 * **Wie das geht:** der Abschnitt wird wörtlich aus `install.sh` geschnitten
 * (von der Modus-Bedingung bis zum Kommentar von Schritt 7). Für den
 * Strg+C-Fall wartet `read` an einer FIFO, an der ein zweiter Deskriptor das
 * Schreibende offen hält; ein Hintergrundprozess schickt dem Skript nach einer
 * Sekunde SIGINT.
 */

import { test as testAlle } from 'node:test';

// Unter Windows nicht ausführbar (bash, FIFO, Signale).
const test = process.platform === 'win32' ? testAlle.skip : testAlle;
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
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

const ABSCHNITT = (quelle: string) =>
  bereich(
    quelle,
    'if [ "$MODE" = "static-docker" ] || [ "$MODE" = "hostproxy" ]; then',
    '# 7) Antwortet der Server unter seiner eigenen Adresse?'
  );

const VORSPANN = `
set -euo pipefail
CONTAINER=pulse
MODE=hostproxy
HTTP_PORT=8080
SRV_HOST=chat.example.org
PROXY_KIND=none
PROXY_CONTAINER=""
log()  { printf 'LOG %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*"; }
`;

function ausfuehren(skript: string): { exit: number | null; ausgabe: string } {
  const lauf = spawnSync('bash', ['-c', skript], { encoding: 'utf8', timeout: 20_000 });
  return { exit: lauf.status, ausgabe: `${lauf.stdout}${lauf.stderr}` };
}

test('die Frage nennt weder „Last step“ noch „check later“, sondern den Befehl zum Verbinden', () => {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const e = ausfuehren(`${VORSPANN}
TTY_GERAET=/dev/null
${funktion(quelle, 'verbinden_spaeter')}
${ABSCHNITT(quelle)}
echo __WEITER__
`);
  assert.equal(e.exit, 0, e.ausgabe);
  assert.doesNotMatch(e.ausgabe, /Last step/);
  assert.doesNotMatch(e.ausgabe, /check later/i);
  assert.match(e.ausgabe, /ONE route in your existing reverse proxy is still needed/);
  assert.match(e.ausgabe, /Ctrl-C/);
  // Der Befehl steht VOR der Aufforderung zu warten, nicht erst nach einem Abbruch.
  const befehl = e.ausgabe.indexOf('docker exec -it pulse pulse-connect');
  const frage = e.ausgabe.indexOf('Press Enter once the route is in place');
  assert.ok(befehl !== -1 && frage !== -1 && befehl < frage, e.ausgabe);
  assert.match(e.ausgabe, /__WEITER__/);
});

test('Strg+C an der Frage gibt den Hinweis zum Verbinden aus und endet mit 130', () => {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-routenfrage-'));
  const fifo = join(dir, 'terminal');
  const e = ausfuehren(`${VORSPANN}
mkfifo "${fifo}"
TTY_GERAET="${fifo}"
# Schreibende offen halten: das Lesen blockiert dann in read, nicht beim Öffnen.
exec 9<>"${fifo}"
( sleep 1; kill -INT $$ ) &
${funktion(quelle, 'verbinden_spaeter')}
${ABSCHNITT(quelle)}
echo __WEITER__
`);
  assert.equal(e.exit, 130, e.ausgabe);
  assert.match(e.ausgabe, /WARN Stopped before the route was checked/);
  assert.match(e.ausgabe, /WARN Connect later: docker exec -it pulse pulse-connect/);
  assert.doesNotMatch(e.ausgabe, /__WEITER__/, 'der Lauf ging nach Strg+C weiter');
});

test('nach der Frage ist der Trap wieder abgenommen', () => {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const e = ausfuehren(`${VORSPANN}
TTY_GERAET=/dev/null
${funktion(quelle, 'verbinden_spaeter')}
${ABSCHNITT(quelle)}
printf 'TRAP=[%s]\\n' "$(trap -p INT)"
`);
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /^TRAP=\[\]$/m, 'der INT-Trap blieb über die Frage hinaus bestehen');
});
