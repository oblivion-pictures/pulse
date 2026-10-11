/**
 * Bildschirmfreigabe über LiveKit: was beim Start eingestellt wird
 * (`bildschirmPlan`), wie ein Fehlschlag gemeldet wird
 * (`bildschirmFehlerMelden`) und der Umweg für den Fenster-Ton unter
 * Windows 11 (`FensterTonUmweg`). Der Ablauf selbst — welcher Weg, wann der
 * Raum noch lebt — steht in `livekit.svelte.ts::setScreenShare`.
 * Schlichtes `.ts` ohne Runes.
 */
import { Track } from 'livekit-client';
import type { LocalParticipant, TrackPublishOptions, VideoResolution } from 'livekit-client';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { settings } from '$lib/stores/settings.svelte';
import { capabilities } from '$lib/stores/capabilities.svelte';
import { effectiveNsLimits } from '$lib/stream/guildLimits';
import { clampNsResolution } from '$lib/settings-registry/sections/screenShare';

/** Die Startwerte einer Freigabe. `s` ist die Einstellung selbst, nicht eine
 *  Kopie: der Windows-Umweg liest `contentHint` erst NACH der Quellenauswahl. */
export interface BildschirmPlan {
  s: typeof settings.screenShare;
  resolution: string;
  /** Die Auflösung zu `resolution`; `undefined` bei `'native'`. */
  aufloesung: VideoResolution | undefined;
  publishOptions: TrackPublishOptions;
}

export function bildschirmPlan(channelId: string | null): BildschirmPlan {
  const s = settings.screenShare;
  // Enforce the effective normal-stream limits (best-effort, client-side
  // — LiveKit/the SFU don't gate these). Effective = this community's
  // per-guild override (Boost) ?? the admin-set instance default. Clamp
  // fps/bitrate into the band and cap the resolution before building.
  const ns = effectiveNsLimits(channelId);
  const fps = Math.min(ns.fpsMax, Math.max(capabilities.nsFpsMin, s.fps));
  const bitrateMbps = Math.min(
    ns.bitrateMaxKbps / 1000,
    Math.max(capabilities.nsBitrateMinKbps / 1000, s.bitrateMbps)
  );
  const resolution = clampNsResolution(s.resolution, ns.resolutionMax);
  const resMap: Record<string, VideoResolution> = {
    '1080p': { width: 1920, height: 1080, frameRate: fps },
    '720p': { width: 1280, height: 720, frameRate: fps },
    '480p': { width: 854, height: 480, frameRate: fps }
  };
  const publishOptions: TrackPublishOptions = {
    videoCodec: s.codec,
    screenShareEncoding: { maxBitrate: bitrateMbps * 1_000_000, maxFramerate: fps }
  };
  return {
    s,
    resolution,
    aufloesung: resolution !== 'native' ? resMap[resolution] : undefined,
    publishOptions
  };
}

/** Ein gescheiterter Start oder Stopp, als Hinweis für den Nutzer. Abbruch und
 *  Verweigerung in der Quellenauswahl bleiben stumm. */
export function bildschirmFehlerMelden(e: unknown): void {
  if (e instanceof Error) {
    const msg = e.message.toLowerCase();
    if (msg.includes('codec') || msg.includes('encodingparameters') || msg.includes('unsupportederror')) {
      // A real codec/encoding rejection from the publish step. AV1 is the
      // more likely culprit (no HW encode on older GPUs + Chromium's WebRTC
      // AV1-encode path is gated). H.264 is the safe fallback we point at.
      const current = settings.screenShare.codec.toUpperCase();
      const fallback = settings.screenShare.codec === 'av1' ? 'H.264' : 'AV1';
      toast.error(m.livekit_codec_unsupported({ current, fallback }));
    } else if (msg.includes('not supported') || msg.includes('failed to start')) {
      // getDisplayMedia couldn't acquire a source.
      toast.error(m.livekit_screenshare_unavailable(), { description: e.message });
    } else if (
      !msg.includes('cancel') &&
      !msg.includes('abort') &&
      !msg.includes('permission') &&
      !msg.includes('denied')
    ) {
      toast.error(m.livekit_screenshare_failed(), { description: e.message });
    }
  }
}

/** Tracks owned by the Win11 per-window-audio bypass path. `null` while the
 *  regular LiveKit `setScreenShareEnabled` path is in use (or no share is
 *  active). We keep raw MediaStreamTracks here so we can `.stop()` them on
 *  teardown — LiveKit's own lifecycle covers only its managed tracks. */
export class FensterTonUmweg {
  #video: MediaStreamTrack | null = null;
  #audio: MediaStreamTrack | null = null;
  /** `ended` handler on the bypass video track — held so `zurueckziehen`
   *  can detach it instead of leaving it bound to a stopped track. */
  #beiEnde: (() => void) | null = null;

  /** Läuft die Freigabe gerade über diesen Umweg? */
  get aktiv(): boolean {
    return this.#video !== null;
  }

  /**
   * Publish a stream acquired by the Win11 per-window-audio bypass path
   * (`getDisplayMedia({ windowAudio:"window" })`) to LiveKit as ScreenShare +
   * ScreenShareAudio tracks. Stops the stream on publish failure so the
   * picker doesn't leak. Hooks `onended` on the video so the browser-side
   * "Stop sharing" bar triggers our own cleanup.
   */
  async veroeffentlichen(
    lp: LocalParticipant,
    stream: MediaStream,
    publishOptions: TrackPublishOptions,
    beiEnde: () => void
  ): Promise<void> {
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('getDisplayMedia returned no video track');
    }
    let videoPublished = false;
    try {
      await lp.publishTrack(videoTrack, { source: Track.Source.ScreenShare, ...publishOptions });
      videoPublished = true;
      if (audioTrack) {
        await lp.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
      }
    } catch (e) {
      // Publish failed mid-way — unpublish the video track if it was already
      // published (otherwise LiveKit holds a ghost screen-share publication
      // pointing at a stopped MediaStreamTrack for the rest of the session).
      if (videoPublished) {
        await lp.unpublishTrack(videoTrack, false).catch(() => undefined);
      }
      // Stop everything we acquired so the browser's picker dialog releases
      // the source (do this after unpublish while the tracks are still alive).
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
    this.#video = videoTrack;
    this.#audio = audioTrack;
    // Browser-side "Stop sharing" bar — Chrome ends the track without telling
    // LiveKit. Translate that into our normal stop path.
    const onEnded = () => {
      if (this.#video === videoTrack) beiEnde();
    };
    this.#beiEnde = onEnded;
    videoTrack.addEventListener('ended', onEnded);
  }

  /** Counterpart to `veroeffentlichen` — unpublish from LiveKit and stop
   *  the underlying MediaStreamTracks. Safe to call when no bypass is active
   *  (no-op). */
  async zurueckziehen(lp: LocalParticipant): Promise<void> {
    const v = this.#video;
    const a = this.#audio;
    if (v && this.#beiEnde) v.removeEventListener('ended', this.#beiEnde);
    this.#beiEnde = null;
    this.#video = null;
    this.#audio = null;
    if (v) {
      try {
        await lp.unpublishTrack(v, true);
      } catch {
        // LiveKit may have already lost the publication (room disconnect race) —
        // we still need to stop the raw track below.
      }
      // unpublishTrack(stopOnUnpublish=true) stops the wrapped track, but our
      // raw MediaStreamTrack reference is what we own — stop it explicitly so
      // the browser's "you are sharing" indicator goes away.
      if (v.readyState !== 'ended') v.stop();
    }
    if (a) {
      try {
        await lp.unpublishTrack(a, true);
      } catch {
        // Same as video — best-effort.
      }
      if (a.readyState !== 'ended') a.stop();
    }
  }

  /** Nach dem Abbau des Raums: Win11 bypass path — stop raw MediaStreamTracks
   *  ourselves; the LiveKit room is gone so unpublishTrack would no-op, but the
   *  OS-level "you are sharing" indicator only goes away when the tracks
   *  actually .stop(). */
  nachAbbauStoppen(): void {
    if (this.#video && this.#beiEnde) {
      this.#video.removeEventListener('ended', this.#beiEnde);
    }
    this.#beiEnde = null;
    if (this.#video && this.#video.readyState !== 'ended') {
      this.#video.stop();
    }
    if (this.#audio && this.#audio.readyState !== 'ended') {
      this.#audio.stop();
    }
    this.#video = null;
    this.#audio = null;
  }
}
