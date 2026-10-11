/**
 * Bausteine der Web-Audio-Kette eines fremden Sprechers
 * (`audioElements.ts`): Knoten trennen, Kompressor und Begrenzer bauen und
 * ein- oder ausfügen. Ohne eigenen Zustand — welche Knoten es gibt, hält
 * `RemoteAudioElements`.
 */
import type { AudioNodeBundle } from './audioElements';

type KompressorWerte = { threshold: number; knee: number; ratio: number; attack: number; release: number };

/** Disconnect every node of `node`'s graph (source → compressor → gain →
 *  limiter). Shared by `detach` (full teardown, anchor goes too) and the
 *  output-device rebuild (graph swap that keeps the anchor + decoder alive).
 *  Idempotent. */
export function graphTrennen(node: AudioNodeBundle): void {
  try { node.source?.disconnect(); } catch { /* already gone */ }
  try { node.compressor?.disconnect(); } catch { /* already gone */ }
  try { node.gain?.disconnect(); } catch { /* already gone */ }
  try { node.limiter?.disconnect(); } catch { /* already gone */ }
}

/** Create a DynamicsCompressorNode with the given parameter set. Shared by the
 *  >100 % boost compressor and the playback peak limiter — both are
 *  DynamicsCompressorNodes differing only in their parameter values. */
export function kompressorBauen(ctx: AudioContext, cfg: KompressorWerte): DynamicsCompressorNode {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = cfg.threshold;
  comp.knee.value = cfg.knee;
  comp.ratio.value = cfg.ratio;
  comp.attack.value = cfg.attack;
  comp.release.value = cfg.release;
  return comp;
}

/** Den Boost-Kompressor zwischen `source` und `gain` einfügen (`noetig`) oder
 *  herausnehmen. Idempotent — verdrahtet nur um, wenn der Stand abweicht. */
export function kompressorAbgleichen(
  ctx: AudioContext,
  node: AudioNodeBundle,
  source: MediaStreamAudioSourceNode,
  gain: GainNode,
  noetig: boolean,
  cfg: KompressorWerte
): void {
  if (noetig && !node.compressor) {
    try { source.disconnect(gain); } catch { /* already detached */ }
    const comp = kompressorBauen(ctx, cfg);
    source.connect(comp);
    comp.connect(gain);
    node.compressor = comp;
  } else if (!noetig && node.compressor) {
    try { source.disconnect(node.compressor); } catch { /* */ }
    try { node.compressor.disconnect(); } catch { /* */ }
    node.compressor = null;
    source.connect(gain);
  }
}

/** Den Begrenzer ans Ende der Kette setzen (`gain → limiter → dest`) oder
 *  herausnehmen (`gain → dest`). Idempotent — only rewires when the actual
 *  state differs, so a plain volume change doesn't glitch the graph. */
export function begrenzerAbgleichen(
  ctx: AudioContext,
  node: AudioNodeBundle,
  gain: GainNode,
  an: boolean,
  dest: AudioNode,
  cfg: KompressorWerte
): void {
  if (an && !node.limiter) {
    try { gain.disconnect(dest); } catch { /* not connected */ }
    const lim = kompressorBauen(ctx, cfg);
    gain.connect(lim);
    lim.connect(dest);
    node.limiter = lim;
  } else if (!an && node.limiter) {
    try { gain.disconnect(node.limiter); } catch { /* */ }
    try { node.limiter.disconnect(); } catch { /* */ }
    node.limiter = null;
    gain.connect(dest);
  }
}
