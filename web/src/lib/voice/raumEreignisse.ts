/**
 * Die LiveKit-Ereignisse eines Raums, verdrahtet auf den Voice-Store
 * (`livekit.svelte.ts`): dort steht, wie ein Raum entsteht und vergeht, hier,
 * worauf er hört. Schlichtes `.ts` ohne Runes — die öffentlichen Felder des
 * Stores kommen als Wirt (`RaumWirt`), seine privaten Stellen als Haken
 * (`RaumHaken`), dasselbe Muster wie `nativeBefehle.ts`. Nur `voiceState`
 * schreiben die Handler direkt.
 */
import {
  ConnectionState,
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track
} from 'livekit-client';
import { voiceState } from './state.svelte';
import type { CameraTracks } from './cameraTracks.svelte';
import type { ScreenShareTracks } from './screenTracks.svelte';
import type { RemoteAudioElements } from './audioElements';
import type { RemoteSpeakingTracker } from './remoteSpeakingTracker';
import { userIdFromIdentity } from './identity';
import { melde } from '$lib/diagnose/app-diagnose';
import { isMobile } from '$lib/platform/runtime';

/** Die öffentlichen Felder des Stores, die die Handler lesen oder schreiben. */
export interface RaumWirt {
  state: ConnectionState;
  channelId: string | null;
  isScreenSharing: boolean;
  isCameraOn: boolean;
  localCameraTrack: LocalVideoTrack | null;
  audioBlocked: boolean;
  audioBlockGrund: string;
}

/** Die privaten Stellen des Stores, die die Handler brauchen. */
export interface RaumHaken {
  /** Ist `room` noch der lebende Raum des Stores? */
  lebt(room: Room): boolean;
  /** `#teardown`. */
  abbauen(): void;
  /** `#scheduleRefresh` — die Teilnehmerliste neu aufbauen (entprellt). */
  neuZeichnen(): void;
  /** Die Geräteliste neu einlesen (`MediaDevicesChanged`). */
  geraeteAuffrischen(): void;
  /** Das eigene Mikrofon ist veröffentlicht — Pegelmesser anhängen. */
  mikroVeroeffentlicht(): void;
  /** Das eigene Mikrofon ist zurückgezogen — Sendefilter-Griffe, Messer und
   *  Sendepegel zurück auf den Ausgangsstand. */
  mikroZurueckgezogen(): void;
  kameras: CameraTracks;
  bildschirme: ScreenShareTracks;
  tonElemente: RemoteAudioElements;
  fremdesSprechen: RemoteSpeakingTracker;
}

export function raumVerdrahten(room: Room, wirt: RaumWirt, haken: RaumHaken): void {
  // Every handler bails when `room` is no longer the active one: a
  // superseded connect() can leave an orphan Room whose late events would
  // otherwise tear down (`#teardown`) or corrupt (`#audioEls` etc.) the
  // live room's state. `_active` is the single guard for that.
  const _active = (): boolean => haken.lebt(room);
  room
    .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
      if (!_active()) return;
      wirt.state = s;
      voiceState.connected = s === ConnectionState.Connected;
      if (s === ConnectionState.Disconnected) haken.abbauen();
    })
    .on(RoomEvent.Disconnected, () => {
      if (!_active()) return;
      haken.abbauen();
    })
    .on(RoomEvent.ParticipantConnected, () => _active() && haken.neuZeichnen())
    .on(RoomEvent.ParticipantDisconnected, () => _active() && haken.neuZeichnen())
    .on(RoomEvent.ActiveSpeakersChanged, () => _active() && haken.neuZeichnen())
    .on(RoomEvent.TrackMuted, (pub, p) => {
      if (!_active()) return;
      // setCameraEnabled(false) mutes the published track instead of
      // unpublishing it — the track stays subscribed forever otherwise. Pull
      // the muted cam out of the visible-cameras list so we don't render a
      // ghost tile with no video flowing.
      if (
        pub.source === Track.Source.Camera &&
        pub.kind === Track.Kind.Video &&
        p instanceof RemoteParticipant
      ) {
        const sid = pub.trackSid ?? pub.track?.sid;
        if (sid) haken.kameras.remove(sid);
      }
      haken.neuZeichnen();
    })
    .on(RoomEvent.TrackUnmuted, (pub, p) => {
      if (!_active()) return;
      if (
        pub.source === Track.Source.Camera &&
        pub.kind === Track.Kind.Video &&
        p instanceof RemoteParticipant &&
        pub.track
      ) {
        haken.kameras.add(pub.track as RemoteVideoTrack, p);
      }
      haken.neuZeichnen();
    })
    .on(RoomEvent.LocalTrackPublished, (pub) => {
      if (!_active()) return;
      if (pub.source === Track.Source.Microphone) {
        // applyNoiseFilter() is called by setMicEnabled() after
        // setMicrophoneEnabled() resolves, which is what triggers this event.
        // Calling it again here would race with that ongoing await, installing
        // two processors and orphaning the first (leaked AudioContext + WASM).
        // attachLocalAnalyser() (hinter `mikroVeroeffentlicht`) is also covered by
        // setMicEnabled → applyNoiseFilter.
        haken.mikroVeroeffentlicht();
      }
      if (pub.source === Track.Source.Camera && pub.track) {
        wirt.localCameraTrack = pub.track as LocalVideoTrack;
      }
      haken.neuZeichnen();
    })
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (!_active()) return;
      if (pub.source === Track.Source.ScreenShare) {
        wirt.isScreenSharing = false;
      }
      if (pub.source === Track.Source.Camera) {
        wirt.isCameraOn = false;
        wirt.localCameraTrack = null;
      }
      if (pub.source === Track.Source.Microphone) {
        haken.mikroZurueckgezogen();
        // Self-monitor is independent of the published track — leave it running.
      }
      haken.neuZeichnen();
    })
    .on(RoomEvent.ConnectionQualityChanged, () => _active() && haken.neuZeichnen())
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (!_active()) return;
      if (track.kind === Track.Kind.Audio) {
        if (pub.source === Track.Source.ScreenShareAudio) {
          haken.bildschirme.addAudio(track as RemoteAudioTrack, p);
        } else {
          haken.tonElemente.attach(
            track as RemoteAudioTrack,
            userIdFromIdentity(p.identity) ?? p.identity,
            (grund) => {
              wirt.audioBlocked = true;
              wirt.audioBlockGrund = grund;
              // Ins Kaefer-Gedaechtnis, nicht nur in die Konsole: am Telefon
              // ist die Konsole nur ueber ein Kabel und Safari erreichbar,
              // und genau dort faellt dieser Fehler an. Ohne Beleg blieb
              // „Audio ist stummgeschaltet" eine Behauptung ohne Ursache.
              melde('voice', 'audio_wiedergabe_abgelehnt', grund, {
                kanal: wirt.channelId ?? '',
                sender: p.identity,
              });
            }
          );
          // Parallel speaking-detector tap on the same raw track — independent
          // of LiveKit's server-side active-speaker decision.
          const ms = (track as RemoteAudioTrack).mediaStreamTrack;
          if (ms) haken.fremdesSprechen.attach(p.identity, ms);
        }
      } else if (track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
        haken.bildschirme.addVideo(track as RemoteVideoTrack, p);
      } else if (track.kind === Track.Kind.Video && pub.source === Track.Source.Camera) {
        // A subscribed camera track can still be muted (publisher turned cam
        // off after a previous on — LiveKit keeps the publication, just mutes
        // it). Wait for TrackUnmuted before showing a tile, otherwise we'd
        // render an empty video element.
        if (!(track as RemoteVideoTrack).isMuted) {
          haken.kameras.add(track as RemoteVideoTrack, p);
        }
      }
      haken.neuZeichnen();
    })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
      if (!_active()) return;
      if (track.source === Track.Source.ScreenShareAudio) {
        haken.bildschirme.removeAudio(track as RemoteAudioTrack);
      } else if (track.kind === Track.Kind.Audio) {
        haken.tonElemente.detach(track.sid ?? '');
        haken.fremdesSprechen.detach(p.identity);
      }
      if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare) {
        haken.bildschirme.removeVideo(track.sid ?? '');
      }
      if (track.kind === Track.Kind.Video && track.source === Track.Source.Camera) {
        haken.kameras.remove(track.sid ?? '');
      }
      haken.neuZeichnen();
    })
    .on(RoomEvent.MediaDevicesChanged, () => {
      if (!_active()) return;
      haken.geraeteAuffrischen();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!_active()) return;
      livekitWiedergabeUebernehmen(wirt, room);
    });
}

/**
 * LiveKits Urteil ueber die Wiedergabe uebernehmen — aber nur dort, wo es
 * eines IST.
 *
 * `room.canPlaybackAudio` beschreibt ausschliesslich die per `track.attach()`
 * angehaengten Elemente des SDK. Auf dem Desktop sind das unsere; auf Mobil
 * legen wir eigene `<audio>`-Elemente an (sie ueberleben die
 * Bildschirmsperre, s. `voice/audioElements.ts`), und LiveKit kennt sie
 * nicht — sein Flag beschreibt dort im Wesentlichen sein eigenes stummes
 * iOS-Hilfselement, das es in `startAudio()` anlegt.
 *
 * **Am 2026-10-10 am Geraet belegt:** die Ueberlagerung „Audio ist
 * stummgeschaltet" erschien, OHNE dass je ein `<audio>.play()` abgelehnt
 * worden waere — der dort angezeigte Grund blieb leer. Sie kam allein von
 * hier. Zuvor stand an dieser Stelle ein halber Schutz („darf nur setzen,
 * nicht aufheben"); der war in die falsche Richtung gedacht: setzen ist
 * genau das, was LiveKit auf Mobil nicht darf.
 *
 * Dort entscheidet allein der Rueckruf aus `tonElemente.attach()` (oben bei
 * `TrackSubscribed`) — der einzige, der den hoerbaren Weg wirklich beobachtet.
 */
function livekitWiedergabeUebernehmen(wirt: RaumWirt, room: Room): void {
  if (isMobile()) return;
  // Läuft nur aus einem Handler, der `lebt(room)` geprüft hat — `room` ist
  // also der Raum, den der Store unter `#room` hält.
  wirt.audioBlocked = !room.canPlaybackAudio;
}
