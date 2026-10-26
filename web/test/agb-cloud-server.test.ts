/**
 * Wann zeigt die Oberfläche die howispulse.com-AGB? Nur in der Cloud — ein
 * Self-Host hat eigene Bedingungen (`src/lib/legal/cloudServer.ts`).
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`. Geprüft wird
 * nur die importfreie Regel, nicht die Abfrage selbst.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { istCloudInfo } from '../src/lib/legal/cloudServer.ts';

describe('istCloudInfo', () => {
  it('die Cloud meldet keine Instanz-Nummer', () => {
    assert.equal(istCloudInfo({ server_version: '0.8.0', instance_id: null }), true);
  });

  it('ein Self-Host meldet seine Instanz-Nummer', () => {
    assert.equal(istCloudInfo({ server_version: '0.8.0', instance_id: '95513383134040064' }), false);
  });

  it('ohne lesbare Antwort gilt der Server als Cloud (lieber ein Hinweis zu viel)', () => {
    assert.equal(istCloudInfo(null), true);
    assert.equal(istCloudInfo('<!doctype html>'), true);
    assert.equal(istCloudInfo({ server_version: '0.8.0' }), true);
  });
});
