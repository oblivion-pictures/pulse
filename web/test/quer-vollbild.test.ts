import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  QuerKacheln,
  QuerVerlauf,
  istEingabe,
  istQuer,
  querVollbildAktion,
  type QuerLage
} from '../src/lib/stream/querVollbild.ts';

// Nutzerwunsch 2026-10-17: iOS-Hülle, HQ-Kachel offen, Telefon quer → Vollbild;
// zurück hoch → Vollbild verlassen. Nur beim Übergang, nur für die gemeinte
// Kachel, nicht mit offener Tastatur.

const lage = (l: Partial<QuerLage>): QuerLage => ({
  quer: false,
  warQuer: false,
  imVollbild: false,
  ziel: true,
  eingabeFokussiert: false,
  ...l
});

test('hoch → quer betritt das Vollbild', () => {
  assert.equal(querVollbildAktion(lage({ quer: true })), 'betreten');
});

test('quer → hoch verlässt es', () => {
  assert.equal(querVollbildAktion(lage({ warQuer: true, imVollbild: true })), 'verlassen');
  assert.equal(querVollbildAktion(lage({ warQuer: true, imVollbild: false })), null);
});

test('nur der Übergang zählt: quer bleibt quer, ein verlassenes Vollbild bleibt verlassen', () => {
  assert.equal(querVollbildAktion(lage({ quer: true, warQuer: true })), null);
  assert.equal(querVollbildAktion(lage({ quer: false, warQuer: false, imVollbild: true })), null);
});

test('schon im Vollbild, nicht gemeint oder Eingabefeld fokussiert: nichts', () => {
  assert.equal(querVollbildAktion(lage({ quer: true, imVollbild: true })), null);
  assert.equal(querVollbildAktion(lage({ quer: true, ziel: false })), null);
  assert.equal(querVollbildAktion(lage({ quer: true, eingabeFokussiert: true })), null);
});

// iPhone 390 x 844 CSS-px: hochkant ist der Viewport 390 breit, quer ~844.
const masse = (breite: number, typ?: string, fensterQuer = breite > 600) => ({
  breite,
  kurzeSeite: 390,
  typ,
  fensterQuer
});

test('Lage: die Breite gegen die kurze Bildschirmseite entscheidet', () => {
  assert.equal(istQuer(masse(390, 'portrait-primary')), false);
  assert.equal(istQuer(masse(844, 'landscape-primary')), true);
});

test('Lage: offene Tastatur kippt nur das Fenster, nicht die Lage', () => {
  assert.equal(istQuer(masse(390, 'portrait-primary', true)), false);
});

test('Lage: ein veralteter Lage-Typ überstimmt die Masse nicht', () => {
  // WKWebView mit Element-Vollbild: `screen.orientation` ist dort nicht
  // verlässlich (WebKit-Bug 280757) — die Masse gelten.
  assert.equal(istQuer(masse(844, 'portrait-primary')), true);
  assert.equal(istQuer(masse(390, 'landscape-secondary')), false);
});

test('Lage: ohne Masse zählt erst der Lage-Typ, dann das Fenster', () => {
  const ohne = { breite: 0, kurzeSeite: 0 };
  assert.equal(istQuer({ ...ohne, typ: 'portrait-primary', fensterQuer: true }), false);
  assert.equal(istQuer({ ...ohne, typ: 'landscape-secondary', fensterQuer: false }), true);
  assert.equal(istQuer({ ...ohne, fensterQuer: true }), true);
  assert.equal(istQuer({ ...ohne, typ: '', fensterQuer: false }), false);
});

const sicht = (quer: boolean, imVollbild: boolean) => ({
  quer,
  imVollbild,
  ziel: true,
  eingabeFokussiert: false
});

test('Verlauf: nur Drehen, beliebig oft', () => {
  const v = new QuerVerlauf(false);
  for (let i = 0; i < 3; i++) {
    assert.equal(v.schritt(sicht(true, false)), 'betreten');
    assert.equal(v.schritt(sicht(false, true)), 'verlassen');
  }
});

test('Verlauf: Knopf-Vollbild, quer, hoch, wieder quer → Vollbild', () => {
  // Der gemeldete Fehler (iOS-Hülle): nach dem Knopf-Vollbild kam das zweite
  // Querformat ohne Vollbild. Quer im Knopf-Vollbild: nichts zu tun.
  const v = new QuerVerlauf(false);
  assert.equal(v.schritt(sicht(true, true)), null);
  assert.equal(v.schritt(sicht(false, true)), 'verlassen');
  // Zweites, gleiches Ereignis derselben Drehung (resize nach change).
  assert.equal(v.schritt(sicht(false, false)), null);
  assert.equal(v.schritt(sicht(true, false)), 'betreten');
});

test('Verlauf: abgleichen nach Vollbild-Wechsel löst nichts aus', () => {
  // Eine Lesung „quer" mitten im Vollbild-Ende (Gerät schon hoch): ohne
  // Abgleich zählte die nächste echte Drehung nicht als Übergang.
  const v = new QuerVerlauf(false);
  v.schritt(sicht(true, true));
  v.abgleichen(false);
  assert.equal(v.schritt(sicht(true, false)), 'betreten');
  // Knopf-Vollbild quer verlassen: Abgleich auf quer → kein Wieder-Betreten.
  const w = new QuerVerlauf(true);
  w.abgleichen(true);
  assert.equal(w.schritt(sicht(true, false)), null);
});

test('Eingabefelder erkennen', () => {
  assert.equal(istEingabe(null), false);
  assert.equal(istEingabe({ tagName: 'TEXTAREA' }), true);
  assert.equal(istEingabe({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(istEingabe({ tagName: 'INPUT' }), true);
  assert.equal(istEingabe({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(istEingabe({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(istEingabe({ tagName: 'BUTTON' }), false);
});

test('eine offene Kachel ist das Ziel; bei mehreren die zuletzt angetippte, sonst keine', () => {
  const k = new QuerKacheln();
  k.anmelden('a');
  assert.equal(k.istZiel('a'), true);
  k.anmelden('b');
  assert.equal(k.istZiel('a'), false);
  assert.equal(k.istZiel('b'), false);
  k.angetippt('b');
  assert.equal(k.istZiel('b'), true);
  assert.equal(k.istZiel('a'), false);
  k.abmelden('b');
  assert.equal(k.istZiel('a'), true, 'wieder allein → wieder Ziel');
  k.angetippt('fremd');
  assert.equal(k.istZiel('fremd'), false, 'nicht angemeldet → nie Ziel');
});
