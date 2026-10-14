import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { kandidatenAusSdp } from '../src/lib/stream/sdpKandidaten.ts';

/** Ausschnitt einer MediaMTX-WHEP-Antwort (Form wie `addAdditionalCandidates`). */
const ANTWORT = [
  'v=0',
  'o=- 1 1 IN IP4 0.0.0.0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=candidate:111 1 udp 2130706431 10.20.0.5 8189 typ host',
  'a=candidate:111 2 udp 2130706431 10.20.0.5 8189 typ host',
  'a=candidate:222 1 udp 2130706431 57.133.64.73 8189 typ host',
  'a=candidate:222 2 udp 2130706431 57.133.64.73 8189 typ host',
  'a=end-of-candidates',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  // Dieselben Kandidaten im zweiten Medienblock — dürfen nicht doppelt auftauchen.
  'a=candidate:111 1 udp 2130706431 10.20.0.5 8189 typ host',
  ''
].join('\r\n');

describe('kandidatenAusSdp', () => {
  it('liest Komponente 1, ohne Doppel, in Reihenfolge', () => {
    assert.equal(
      kandidatenAusSdp(ANTWORT),
      'udp 10.20.0.5:8189 host, udp 57.133.64.73:8189 host'
    );
  });

  it('nimmt auch TCP und srflx mit, mit \\n als Zeilenende', () => {
    const sdp = [
      'a=candidate:1 1 TCP 1671430143 203.0.113.7 8189 typ host tcptype passive',
      'a=candidate:2 1 udp 1694498815 198.51.100.9 50000 typ srflx raddr 0.0.0.0 rport 0'
    ].join('\n');
    assert.equal(kandidatenAusSdp(sdp), 'tcp 203.0.113.7:8189 host, udp 198.51.100.9:50000 srflx');
  });

  it('ohne Kandidaten: „keine"', () => {
    assert.equal(kandidatenAusSdp('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'), 'keine');
  });

  it('kaputte Zeilen fallen heraus', () => {
    assert.equal(kandidatenAusSdp('a=candidate:kaputt\r\na=candidate:1 1 udp 1 1.2.3.4 5 xx host'), 'keine');
  });

  it('deckelt die Liste und nennt den Rest', () => {
    const sdp = Array.from({ length: 11 }, (_, i) => `a=candidate:${i} 1 udp 1 10.0.0.${i} 8189 typ host`).join('\n');
    const out = kandidatenAusSdp(sdp);
    assert.ok(out.endsWith('(+3)'), out);
    assert.equal(out.split(', ').length, 8);
  });
});
