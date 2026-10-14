import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { istAngekommen, type StreamStand } from '../src/lib/stream/ankunft.ts';

const KANAL = '99515546613063680';
const ICH = '53552549688512512';
const ANDERER = '11111111111111111';

describe('istAngekommen', () => {
  it('kein Eintrag für den Kanal heisst: nicht angekommen', () => {
    assert.equal(istAngekommen([], KANAL, ICH, 0), false);
    const fremd: StreamStand[] = [
      { channel_id: 'anderer-kanal', user_ids: [ICH] },
    ];
    assert.equal(istAngekommen(fremd, KANAL, ICH, 0), false);
  });

  it('einslotige Form: user_ids stehen für Platz 0', () => {
    const staende: StreamStand[] = [
      { channel_id: KANAL, user_ids: [ANDERER, ICH] },
    ];
    assert.equal(istAngekommen(staende, KANAL, ICH, 0), true);
    // Ohne `streams` kann ein höherer Platz nicht belegt sein.
    assert.equal(istAngekommen(staende, KANAL, ICH, 1), false);
  });

  it('nur ein anderer sendet: nicht angekommen', () => {
    const staende: StreamStand[] = [{ channel_id: KANAL, user_ids: [ANDERER] }];
    assert.equal(istAngekommen(staende, KANAL, ICH, 0), false);
  });

  it('mehrslotige Form: Nutzer UND Platz müssen passen', () => {
    const staende: StreamStand[] = [
      {
        channel_id: KANAL,
        user_ids: [ICH],
        streams: [
          { user_id: ICH, slot: 0 },
          { user_id: ANDERER, slot: 1 },
        ],
      },
    ];
    assert.equal(istAngekommen(staende, KANAL, ICH, 0), true);
    // Platz 1 gehört dem anderen, nicht mir.
    assert.equal(istAngekommen(staende, KANAL, ICH, 1), false);
  });

  it('ein fehlender Platz in `streams` zählt als 0', () => {
    const staende: StreamStand[] = [
      {
        channel_id: KANAL,
        user_ids: [ICH],
        streams: [{ user_id: ICH }, { user_id: ICH, slot: 1 }],
      },
    ];
    assert.equal(istAngekommen(staende, KANAL, ICH, 0), true);
    assert.equal(istAngekommen(staende, KANAL, ICH, 1), true);
  });
});
