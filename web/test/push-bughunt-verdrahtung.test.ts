import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Die Verdrahtung aus dem Push-Bughunt vom 2026-10-20. **Warum der Test die
 * Quelle liest:** die betroffenen Module ziehen `$lib`-Aliase, Stores und
 * Capacitor nach sich, die Nodes Testläufer nicht auflöst (`pnpm test:unit`-
 * Falle in CLAUDE.md). Die reinen Rechnungen prüft `push-bughunt-kerne`.
 */
const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');

test('Befund 1: Takt und Weckruf nehmen denselben Anzeige-Weg, jedes Ergebnis einmal', () => {
  const layout = lies('routes/app/+layout.svelte');
  assert.match(
    layout,
    /beiHintergrund\(\(\) => hintergrundZyklusStarten\(postfachImHintergrundAbholen\)\)/
  );
  const chat = lies('lib/ws/handlers/chat.ts');
  assert.match(
    chat,
    /export function postfachImHintergrundAbholen\(\): void \{\s*postfachAbholenUndAnzeigen\(weckrufAboBlick \?\? \(\(\) => false\), \{ stumm: true \}\);/
  );
  assert.match(chat, /if \(verbucht\.has\(neue\)\) return;\s*verbucht\.add\(neue\);/);
  // Der Takt selbst holt nicht mehr ab, er ruft nur die Runde.
  assert.doesNotMatch(lies('lib/krypto/hintergrundTakt.ts'), /postfachAbholenUndEntschluesseln\(/);
});

test('Befund 2: eine stumme Gruppe zählt, meldet sich aber nicht', () => {
  const verbuchen = lies('lib/ws/handlers/postfachVerbuchen.ts');
  assert.match(
    verbuchen,
    /readState\.incUnread\([^)]*\);\s*if \(stumm \|\| \(gruppe && privateGruppen\.eigenesStumm\(gruppe, me\)\)\) continue;\s*(\/\/[^\n]*\n\s*)*meldeNeueZustellung\(/
  );
});

test('Befund 3: Lesen räumt die Meldungen der Unterhaltung, Abmelden alle', () => {
  assert.match(lies('lib/stores/readState.svelte.ts'), /markRead\([^)]*\): void \{\s*for \(const haken of this\.leseHaken\) haken\(channelId\);/);
  assert.match(lies('lib/platform/fcm.ts'), /readState\.beimLesen\(zugestellteMeldungenEntfernen\)/);
  assert.match(lies('lib/platform/geraetetokenAbmelden.ts'), /void alleZugestelltenMeldungenEntfernen\(\);/);
});

test('Befund 4: fällt die Sperre im Hintergrund weg, prüft netzwache nach', () => {
  const layout = lies('routes/app/+layout.svelte');
  assert.match(layout, /hintergrundTrennSperre\(trennGesperrt\)/);
  assert.match(layout, /if \(!trennGesperrt\(\)\) untrack\(trennSperrenNachpruefen\);/);
  const wache = lies('lib/ws/netzwache.ts');
  assert.match(wache, /imHintergrund = !isActive;/);
  assert.match(wache, /export function trennSperrenNachpruefen\(\): void/);
});

test('Befunde 5–7: Hörer einmal, Token-Rotation, Fähigkeiten beim Melden', () => {
  const fcm = lies('lib/platform/fcm.ts');
  assert.match(fcm, /if \(!installiert\) \{\s*installiert = true;/);
  assert.match(fcm, /if \(hoererBereit\) return;\s*hoererBereit = true;/);
  assert.match(fcm, /addListener\('tokenReceived'/);
  assert.match(fcm, /\.\.\.\(faehigkeiten \? \{ faehigkeiten \} : \{\}\)/);
});

test('Befund 8: die aufbewahrte Anruf-Entscheidung geht durch dieselbe Verarbeitung', () => {
  const huelle = lies('lib/anrufe/anrufHuelle.ts');
  assert.match(
    huelle,
    /const aktion = alsAnrufAktion\(roh\);\s*if \(aktion\) \{\s*nativeAktionVerarbeiten\(anrufe, aktion\);/
  );
  assert.match(huelle, /anrufe\.eingehend\(klingelt\.anruf, klingelt\.name \?\? 'Pulse', \{ ton: false \}\)/);
  // Die Android-Methoden stehen NICHT in der iOS-Prüfliste.
  const bruecke = lies('lib/platform/anrufNativ.ts');
  const liste = bruecke.slice(bruecke.indexOf('ANRUF_RAUM_METHODEN'));
  assert.doesNotMatch(liste.slice(0, liste.indexOf('satisfies')), /ausstehendeAktion|faehigkeiten:/);
});

test('Befund 10: der Mitteilungs-Abschnitt steht in beiden Hüllen', () => {
  assert.match(
    lies('lib/components/settings/SettingsNotifications.svelte'),
    /\{#if huelle\}\s*<HuelleMitteilungen \/>/
  );
});

test('Befund 11: der Server-Wechsel behält die Kanäle des Kontos', () => {
  assert.match(
    lies('lib/stores/multi-server-reset.ts'),
    /readState\.resetCacheOnly\(\s*\(kanalId\) => kanalId in directMessages\.byId \|\| privateGruppen\.istGruppe\(kanalId\)\s*\)/
  );
});

test('Befund 12: am Handy gibt es den knappen Toast, oben', () => {
  const meldung = lies('lib/ws/handlers/postfachBenachrichtigung.ts');
  assert.doesNotMatch(meldung, /!viewport\.isMobile/);
  assert.match(meldung, /viewport\.isMobile \? \{ position: 'top-center' as const \} : \{\}/);
});

test('Nur der Anzeige-Weg holt das Postfach ab (Bughunt 2, Web-Befund 1)', async () => {
  // `mitNachlaufBeiWeckung` gibt das Ergebnis eines Zyklus nur dem zurück, der
  // ihn startete. Startet ein anderer Aufrufer den Zyklus, sind die Nachrichten
  // abgeholt, abgelegt und quittiert, erscheinen aber nicht im offenen
  // Gespräch und zählen nicht als ungelesen — so geschehen im Hintergrund-Takt
  // (bis 2026-10-20) und beim Annehmen eines Anrufs (`anrufSchluesselweg.ts`).
  const { readdirSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const wurzel = new URL('../src/', import.meta.url).pathname;
  const dateien: string[] = [];
  const gehe = (ordner: string): void => {
    for (const name of readdirSync(ordner)) {
      const pfad = join(ordner, name);
      if (statSync(pfad).isDirectory()) gehe(pfad);
      else if (/\.(ts|svelte)$/.test(name)) dateien.push(pfad);
    }
  };
  gehe(wurzel);
  const aufrufer = dateien
    .filter((pfad) => /postfachAbholenUndEntschluesseln\(\)/.test(readFileSync(pfad, 'utf8')))
    .map((pfad) => relative(wurzel, pfad))
    .sort();
  assert.deepEqual(aufrufer, ['lib/ws/handlers/chat.ts']);
});

test('Entscheid 2026-10-21: Anruf in der App bei „Nicht stören“ oder stummer Gruppe still', () => {
  // Der Server klingelt per Push dann nicht (`anruf_push.py`), schickt das
  // `call_klingelt` über die WebSocket aber trotzdem — „ob sie klingelt,
  // entscheidet die Oberfläche“. Still heißt: Overlay ja, kein Ton, kein
  // natives Klingeln (Android-Klingelmeldung, iOS-CallKit).
  const handler = lies('lib/ws/handlers/anrufe.ts');
  assert.match(handler, /const still = isDnd\(\) \|\| gruppeStumm\(evt\.channel_id\);/);
  assert.match(handler, /anrufe\.eingehend\(evt, gegenstelle, \{ ton: !still, nativ: !still \}\);/);
  const anruf = lies('lib/anrufe/anruf.svelte.ts');
  assert.match(anruf, /\{ ton = true, nativ = true \}: \{ ton\?: boolean; nativ\?: boolean \} = \{\}/);
  assert.match(anruf, /if \(nativ\) void nativAnkommen\(evt\.call_id, gegenstelle\);/);
});
