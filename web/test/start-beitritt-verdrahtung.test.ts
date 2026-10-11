import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * iOS-Bughunt 2 vom 2026-10-11 (N1, D1, B1/D2, F4) — der
 * Verdrahtungs-Vertrag um `voice/startBeitritt.ts`. Die Entscheidungen selbst
 * prüft `start-beitritt.test.ts`; hier steht, dass sie an den Stellen
 * ankommen, die sie brauchen. Als Text gelesen, weil Svelte-Dateien, Runes
 * und die Swift-Hülle im Node-Läufer nicht laufen (dasselbe Muster wie
 * `anruf-sperrbildschirm-verdrahtung.test.ts`).
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (pfad: string) => readFileSync(join(webRoot, pfad), 'utf8');
const vor = (text: string, a: string, b: string) => {
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  assert.ok(i >= 0, `fehlt: ${a}`);
  assert.ok(j >= 0, `fehlt: ${b}`);
  assert.ok(i < j, `${a} muss vor ${b} stehen`);
};

test('D1: jeder Weg von aussen meldet sich als „von aussen" an', () => {
  for (const pfad of [
    'src/lib/platform/universalLinks.ts',
    'src/lib/platform/schnellwahl.ts',
    'src/lib/platform/fcm.ts',
    'src/lib/notifications/inPage.ts'
  ]) {
    const quelle = lies(pfad);
    assert.match(quelle, /vonAussenOeffnen\(/, pfad);
    assert.doesNotMatch(
      quelle,
      /import \{[^}]*\bgoto\b[^}]*\} from '\$app\/navigation'/,
      `${pfad}: ein blankes goto() wäre ein Tipp in der App`
    );
  }
  const layout = lies('src/routes/app/+layout.svelte');
  const mitteilung = layout.slice(
    layout.indexOf('function navigateToFromNotification'),
    layout.indexOf('let _swMessageHandler')
  );
  assert.match(mitteilung, /vonAussenOeffnen\(targetUrl\)/);
  assert.match(mitteilung, /vonAussenOeffnen\(url\)/);
  assert.doesNotMatch(mitteilung, /void goto\(/);
});

test('Die Herkunft wird im ROOT-Layout verfolgt', () => {
  assert.match(lies('src/routes/+layout.svelte'), /navigationsHerkunftVerfolgen\(\);/);
});

test('N1/F4: Start-Reihenfolge — Sperre, Abgleich+Resume, Auto-Connect, dann das Tor', () => {
  const start = lies('src/lib/voice/startBeitritte.ts');
  vor(start, 'startTor.schliessen()', 'await appSperre.entsperrt()');
  vor(start, 'await appSperre.entsperrt()', 'await resumeVoiceIfPending()');
  vor(start, 'await resumeVoiceIfPending()', 'await autoConnectIfConfigured()');
  vor(start, 'await autoConnectIfConfigured()', 'startTor.oeffnen()');
  // Das Layout ruft nur noch die Reihenfolge, nicht mehr die Teile.
  const layout = lies('src/routes/app/+layout.svelte');
  assert.match(layout, /startBeitritteAusfuehren\(\)/);
  assert.doesNotMatch(layout, /resumeVoiceIfPending|autoConnectIfConfigured/);
});

test('Die Kanal-Route fragt die Regel, statt selbst zu entscheiden', () => {
  const route = lies('src/routes/app/guilds/[guildId]/channels/[channelId]/+page.svelte');
  assert.match(route, /routenBeitrittVerdrahten\(/);
  assert.doesNotMatch(route, /!voice\.connected && !voice\.connecting\) void voice\.connect/);
  const verdrahtung = lies('src/lib/voice/routenBeitritt.svelte.ts');
  assert.match(verdrahtung, /startFertig: startTor\.fertig/);
  assert.match(verdrahtung, /gesperrt: appSperre\.gesperrt/);
  assert.match(verdrahtung, /herkunft: navigationsHerkunft\(\)/);
});

test('F4: ein Holen in den Kanal (voice_pull) wartet auf das Tor', () => {
  vor(lies('src/lib/ws/handlers/voice.ts'), 'startTor', 'voice.connect(evt.channel_id');
});

test('B1: die Hülle meldet das Auflegen, und das Web kennt das Feld', () => {
  const ios = (datei: string) => lies(`../mobile/ios/App/App/${datei}`);
  assert.match(ios('SpracheRaumZustand.swift'), /"aufgelegtSitzung": aufgelegtSitzung/);
  // Beide Knöpfe der Hülle, die selbst auflegen.
  assert.match(ios('SpracheSteuerleiste.swift'), /await vomNutzerAufgelegt\(\)/);
  assert.match(ios('SpracheLiveAktivitaet.swift'), /await vomNutzerAufgelegt\(\)/);
  assert.match(lies('src/lib/platform/iosSpracheTypen.ts'), /aufgelegtSitzung\?: number \| null/);
});
