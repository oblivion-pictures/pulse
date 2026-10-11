/**
 * Die eigene Webcam auf dem Web-Weg: veröffentlichen, zurückziehen, zwischen
 * Front- und Rückkamera wechseln. Der native Weg (iOS) bleibt im Voice-Store
 * (`livekit.svelte.ts::setCamera`/`flipCamera`), ebenso der Raum selbst — hier
 * wird er nur benutzt. Schlichtes `.ts` ohne Runes; die Felder, die sich
 * ändern, gehören dem Wirt.
 */
import { Track, type LocalVideoTrack, type Room } from 'livekit-client';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { capabilities } from '$lib/stores/capabilities.svelte';
import { quelleZuruecknehmen } from './abbruch';
import { kameraAufloesung } from './kameraAufloesung';

/** Die Felder des Stores, die die Kamera schreibt. */
export interface KameraWirt {
  isCameraOn: boolean;
  localCameraTrack: LocalVideoTrack | null;
  cameraFacing: 'user' | 'environment';
}

/** Webcam capture resolution + fps, derived from the admin-configured
 *  instance ceiling (capabilities.camResolutionMax / camFpsMax). The
 *  defaults (720p/30) mirror the formerly hard-coded values, so nothing
 *  changes until an admin raises the cap in /app/admin. Used for both the
 *  initial publish and flipCamera's in-place restart so a facing swap keeps
 *  the same quality. LiveKit's adaptiveStream still downscales per subscriber. */
function kameraAufnahme(): { width: number; height: number; frameRate: number } {
  return kameraAufloesung(capabilities.camResolutionMax, capabilities.camFpsMax);
}

/** Publish/unpublish the local camera track. Capture resolution + fps come
 *  from the admin-configured instance ceiling (`kameraAufnahme`); the
 *  default 720p/30 keeps egress sane when several cams are on at once.
 *  `lebt` sagt, ob `room` nach einem `await` noch der Raum des Stores ist. */
export async function kameraSetzen(
  room: Room | null,
  on: boolean,
  wirt: KameraWirt,
  lebt: () => boolean
): Promise<void> {
  if (!room) {
    // Pressed before the voice room finished connecting (mobile auto-join
    // race) — previously this was a silent no-op, which read as "nothing
    // happens" to the user.
    if (on)
      toast.error(m.livekit_camera_failed(), {
        description: 'Voice ist noch nicht verbunden.'
      });
    return;
  }
  try {
    if (on) {
      await room.localParticipant.setCameraEnabled(true, {
        resolution: kameraAufnahme(),
        facingMode: wirt.cameraFacing
      });
      // Aufgelegt waehrend des `await`: die Kamera laeuft bereits, der Raum
      // ist aber schon abgebaut — Spur zuruecknehmen, sonst bleibt die
      // Kamera-Anzeige des Geraets an.
      if (!lebt()) {
        await quelleZuruecknehmen(room, Track.Source.Camera);
        return;
      }
      wirt.isCameraOn = true;
    } else {
      // Turn the cam OFF by *unpublishing*, not just muting. LiveKit's
      // setCameraEnabled(false) only mutes — the publication stays alive, so
      // (a) the server-side track_unpublished webhook never fires and
      // voice-signaling's camera-presence set keeps the CAM badge lit on every
      // client, and (b) our own RoomEvent.LocalTrackUnpublished handler never
      // runs, so localCameraTrack stays set and the self-preview tile lingers.
      // Unpublishing (stopOnUnpublish=true) tears both down — and releases the
      // camera hardware/LED, which mute does not. Mirrors screen-share stop.
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const track = (pub?.videoTrack as LocalVideoTrack | undefined) ?? wirt.localCameraTrack;
      if (track) {
        await room.localParticipant.unpublishTrack(track, true);
      } else {
        await room.localParticipant.setCameraEnabled(false);
      }
      wirt.isCameraOn = false;
      wirt.localCameraTrack = null;
    }
  } catch (e) {
    wirt.isCameraOn = false;
    // Surface the failure instead of swallowing it. On mobile a denied
    // camera permission or a busy device is the usual cause, and silently
    // eating the error left the user with no idea why the cam stayed off.
    console.error('[voice] camera enable failed', e);
    if (e instanceof Error) {
      toast.error(m.livekit_camera_failed(), { description: e.message });
    }
  }
}

/** Switch between front ('user') and back ('environment') camera. Restarts
 *  the existing publication's track in place so the swap is seamless and
 *  remote subscribers keep the same track. No-op unless the cam is live. */
export async function kameraWechseln(wirt: KameraWirt): Promise<void> {
  const track = wirt.localCameraTrack;
  if (!track) return;
  const next = wirt.cameraFacing === 'user' ? 'environment' : 'user';
  try {
    await track.restartTrack({
      resolution: kameraAufnahme(),
      facingMode: next
    });
    wirt.cameraFacing = next;
  } catch (e) {
    console.error('[voice] camera flip failed', e);
    if (e instanceof Error) toast.error(m.livekit_camera_failed(), { description: e.message });
  }
}
