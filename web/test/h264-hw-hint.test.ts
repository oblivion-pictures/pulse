/**
 * H.264-HW-Encode-Hint: sortiert beim Senden das Software-Profil nach hinten,
 * lässt Empfänger (WHEP, `recvonly`) aber unangetastet — sonst fiele jeder
 * Codec aus dem Angebot, den der Rechner dekodieren, aber nicht kodieren kann
 * (H265 unter Linux + NVIDIA, 2026-10-28).
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const sendeListe = [
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=42e01f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=64001f' },
  { mimeType: 'video/AV1', clockRate: 90000 },
];

const gesetzt: Array<{ direction?: string; codecs: unknown[] }> = [];

class FakePeerConnection {
  addTransceiver(_kind: string, init?: { direction?: string }) {
    return {
      setCodecPreferences(codecs: unknown[]) {
        gesetzt.push({ direction: init?.direction, codecs });
      },
    };
  }
}

const g = globalThis as Record<string, unknown>;
g.RTCPeerConnection = FakePeerConnection;
g.RTCRtpSender = { getCapabilities: () => ({ codecs: sendeListe, headerExtensions: [] }) };

const { installH264HwHint } = await import('../src/lib/voice/h264HwHint.ts');
installH264HwHint();

test('senden: Software-Profil 42e01f rückt ans Ende', () => {
  gesetzt.length = 0;
  new FakePeerConnection().addTransceiver('video', { direction: 'sendonly' });
  assert.equal(gesetzt.length, 1);
  const profile = (gesetzt[0].codecs as Array<{ sdpFmtpLine?: string }>).map((c) => c.sdpFmtpLine);
  assert.deepEqual(profile, ['profile-level-id=64001f', undefined, 'profile-level-id=42e01f']);
});

test('recvonly (WHEP-Zuschauer): keine Preference, das Angebot bleibt vollständig', () => {
  gesetzt.length = 0;
  new FakePeerConnection().addTransceiver('video', { direction: 'recvonly' });
  assert.equal(gesetzt.length, 0);
});

test('Audio bleibt unangetastet', () => {
  gesetzt.length = 0;
  new FakePeerConnection().addTransceiver('audio', { direction: 'sendonly' });
  assert.equal(gesetzt.length, 0);
});
