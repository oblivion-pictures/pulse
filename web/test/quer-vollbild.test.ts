import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  QuerKacheln,
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

test('Lage: der Bildschirm zählt vor dem Fenster (Tastatur kippt nur das Fenster)', () => {
  assert.equal(istQuer('portrait-primary', true), false);
  assert.equal(istQuer('landscape-secondary', false), true);
  assert.equal(istQuer(undefined, true), true);
  assert.equal(istQuer('', false), false);
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
