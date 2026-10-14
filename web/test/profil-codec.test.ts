import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  farbSchalter,
  hdrGilt,
  istProfilCodec,
  profilCodecFuerKarte,
  profilCodecOptionen,
} from '../src/lib/devices/profilCodec.ts';

// Der Anlass (2026-10-14): RTX 3060 Ti — HEVC ja, AV1 nein.
const RTX3060TI = { hasAv1: false, hasHevc: true };
const NUR_H264 = { hasAv1: false, hasHevc: false };
const ALLES = { hasAv1: true, hasHevc: true };

describe('profilCodecOptionen', () => {
  it('bietet HEVC an, AV1 nicht, wenn die Karte nur HEVC kann', () => {
    assert.deepEqual(profilCodecOptionen(RTX3060TI), ['h264', 'hevc']);
  });

  it('H.264 steht immer da', () => {
    assert.deepEqual(profilCodecOptionen(NUR_H264), ['h264']);
  });

  it('alles bei voller Karte', () => {
    assert.deepEqual(profilCodecOptionen(ALLES), ['h264', 'hevc', 'av1']);
  });

  it('ungemessen bleibt alles stehen', () => {
    assert.deepEqual(profilCodecOptionen(undefined), ['h264', 'hevc', 'av1']);
  });
});

describe('profilCodecFuerKarte', () => {
  it('AV1 ohne AV1-Encoder wird HEVC, wenn die Karte das kann', () => {
    assert.equal(profilCodecFuerKarte('av1', RTX3060TI), 'hevc');
  });

  it('AV1 auf einer reinen H.264-Karte wird H.264', () => {
    assert.equal(profilCodecFuerKarte('av1', NUR_H264), 'h264');
  });

  it('HEVC ohne HEVC-Encoder folgt der Staffel (AV1 vor H.264)', () => {
    assert.equal(profilCodecFuerKarte('hevc', { hasAv1: true, hasHevc: false }), 'av1');
    assert.equal(profilCodecFuerKarte('hevc', NUR_H264), 'h264');
  });

  it('Einlösbares bleibt, Ungemessenes auch', () => {
    assert.equal(profilCodecFuerKarte('hevc', RTX3060TI), 'hevc');
    assert.equal(profilCodecFuerKarte('h264', NUR_H264), 'h264');
    assert.equal(profilCodecFuerKarte('av1', undefined), 'av1');
  });
});

describe('istProfilCodec', () => {
  it('kennt genau die drei Werte', () => {
    for (const c of ['h264', 'hevc', 'av1']) assert.equal(istProfilCodec(c), true);
    for (const c of ['H264', 'vp9', '', null, undefined, 1]) assert.equal(istProfilCodec(c), false);
  });
});

describe('farbSchalter', () => {
  const alle = { tenBitAvailable: true, hevcTenBitAvailable: true, hdrAvailable: true };

  it('HEVC: 10 bit nach der HEVC-Meldung, nie HDR', () => {
    assert.deepEqual(farbSchalter('hevc', alle), { zehnBit: true, hdr: false });
    assert.deepEqual(farbSchalter('hevc', { ...alle, hevcTenBitAvailable: false }), {
      zehnBit: false,
      hdr: false,
    });
  });

  it('AV1: 10 bit nach der AV1-Meldung, HDR nur mit 10 bit', () => {
    assert.deepEqual(farbSchalter('av1', alle), { zehnBit: true, hdr: true });
    assert.deepEqual(farbSchalter('av1', { ...alle, tenBitAvailable: false }), {
      zehnBit: false,
      hdr: false,
    });
  });

  it('H.264: weder noch', () => {
    assert.deepEqual(farbSchalter('h264', alle), { zehnBit: false, hdr: false });
  });
});

describe('hdrGilt', () => {
  it('nur mit AV1', () => {
    assert.equal(hdrGilt('av1', true), true);
    assert.equal(hdrGilt('hevc', true), false);
    assert.equal(hdrGilt('h264', true), false);
    assert.equal(hdrGilt('av1', false), false);
  });
});
