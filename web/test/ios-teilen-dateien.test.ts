import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Teilen mit mehreren Dateien (E5): Hülle und Web müssen dieselben Namen,
// Grenzen und Antwortfelder sprechen. Die Hülle hat kein Swift-Testziel;
// gehalten wird am Quelltext, wie bei den übrigen Verträgen.

const ios = (f: string) =>
  readFileSync(new URL(`../../mobile/ios/App/${f}`, import.meta.url), 'utf8');
const web = (f: string) => readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8');

test('Plugin-Methoden der Hülle und der Brücke stimmen überein', () => {
  const plugin = ios('App/ShareReceiverPlugin.swift');
  const brücke = web('platform/shareReceiverPlugin.ts');
  for (const m of ['getPending', 'leseDatei', 'abschliessen']) {
    assert.match(plugin, new RegExp(`CAPPluginMethod\\(name: "${m}"`), `Hülle ohne ${m}`);
    assert.match(brücke, new RegExp(`\\b${m}\\(`), `Brücke ohne ${m}`);
  }
  // Antwortfelder des Verzeichnisses
  for (const f of ['paketId', 'dateien', 'uebersprungen', 'groesse']) {
    assert.match(plugin, new RegExp(`"${f}"`), `Hülle liefert ${f} nicht`);
    assert.match(brücke, new RegExp(`\\b${f}\\??:`), `Brücke kennt ${f} nicht`);
  }
  assert.match(plugin, /call\.getBool\("mitDateien"\)/);
  assert.match(web('platform/shareEmpfang.ts'), /getPending\(\{ mitDateien: true \}\)/);
});

test('Stückgrösse und Anzahl sind auf beiden Seiten gleich', () => {
  assert.match(ios('App/ShareReceiverPlugin.swift'), /stueckBytes = 384 \* 1024/);
  assert.match(web('freigabe/freigabeRechnung.ts'), /STUECK_BYTES = 384 \* 1024/);
  assert.match(ios('Gemeinsam/TeilenAblage.swift'), /hoechstensElemente = 10/);
  assert.match(web('freigabe/freigabeRechnung.ts'), /FREIGABE_MAX_DATEIEN = 10/);
});

test('Grenzen der Erweiterung: 25 MiB je Datei wie der Server-Standard, Gesamtgrenze, 24 Stunden', () => {
  const ablage = ios('Gemeinsam/TeilenAblage.swift');
  assert.match(ablage, /dateiBytes = 25 \* 1024 \* 1024/);
  assert.match(ablage, /gesamtBytes = 100 \* 1024 \* 1024/);
  assert.match(ablage, /aufbewahrung: TimeInterval = 24 \* 60 \* 60/);
});

test('Kennungen führen nie aus dem Ordner: nur UUID-Formen', () => {
  const ablage = ios('Gemeinsam/TeilenAblage.swift');
  assert.match(ablage, /guard UUID\(uuidString: paketId\) != nil/);
  assert.match(ablage, /guard UUID\(uuidString: id\) != nil/);
  assert.match(ios('App/ShareReceiverPlugin.swift'), /TeilenAblage\.datei\(paketId: paketId, id: id\)/);
});

test('Aktivierungsregel: Prädikat mit Bild, Film, Adresse, Text und Datei, ohne Obergrenze', () => {
  const plist = ios('ShareExtension/Info.plist');
  assert.match(plist, /<key>NSExtensionActivationRule<\/key>\s*<string>SUBQUERY/);
  for (const t of ['public.image', 'public.movie', 'public.url', 'public.plain-text', 'public.data']) {
    assert.match(plist, new RegExp(`UTI-CONFORMS-TO "${t.replace('.', '\\.')}"`), t);
  }
  assert.doesNotMatch(plist, /WithMaxCount/);
});

test('Die Karte bleibt stehen, bis „OK“ getippt wird', () => {
  const karte = ios('ShareExtension/ShareViewController.swift');
  assert.doesNotMatch(karte, /Task\.sleep/);
  assert.match(karte, /%lld Elemente bereit/);
});

test('Die Erweiterung hat einen eigenen Katalog im Ziel', () => {
  const projekt = ios('App.xcodeproj/project.pbxproj');
  assert.match(projekt, /7E11E00000000000000002A4 \/\* Localizable\.xcstrings in Resources \*\//);
  assert.match(projekt, /7E11E00000000000000002A2 \/\* TeilenDateien\.swift in Sources \*\//);
});
