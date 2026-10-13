/**
 * Hilfsmodul für `doppelter-ton.spec.ts` — der Vite-Dev-Server liefert es dem
 * Browser (`import('/tests/e2e/_tonKachel.ts')`). Es stellt echte LiveKit-
 * Objekte und die echte `ScreenShareTile` bereit, ohne dass ein LiveKit-Server
 * läuft (den gibt es unter Test nicht, s. `overnight-voice.spec.ts`).
 */
import { mount, unmount } from 'svelte';
import { Room, RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
import ScreenShareTile from '$lib/components/ScreenShareTile.svelte';

/** Quellen der Test-Spuren — eigener Kontext, damit er in keiner Zählung der
 *  AudioContexts der App auftaucht (er entsteht vor deren Beobachtung). */
let quelle: AudioContext | null = null;

/** Ohne Gegenstelle gibt es keinen Empfänger (`receiver`); die Tests kommen ohne aus. */
const OHNE_EMPFAENGER = undefined as unknown as RTCRtpReceiver;

/** Eine echte `RemoteAudioTrack` über einem Dauerton. */
export function tonSpur(sid: string): RemoteAudioTrack {
  quelle ??= new AudioContext();
  const ziel = quelle.createMediaStreamDestination();
  const osz = quelle.createOscillator();
  osz.connect(ziel);
  osz.start();
  return new RemoteAudioTrack(ziel.stream.getAudioTracks()[0], sid, OHNE_EMPFAENGER);
}

/** Eine echte `RemoteVideoTrack` über einer Zeichenfläche. */
export function bildSpur(sid: string): RemoteVideoTrack {
  const flaeche = document.createElement('canvas');
  flaeche.width = flaeche.height = 64;
  return new RemoteVideoTrack(flaeche.captureStream(5).getVideoTracks()[0], sid, OHNE_EMPFAENGER);
}

/** Ein echter `Room`, in dem die Spuren als Ton einer fremden Teilnehmerin
 *  stehen — `startAudio()` liest genau diese Sammlung. */
export function raumMit(...spuren: RemoteAudioTrack[]): Room {
  const raum = new Room();
  // Ohne `connect()` stünde der Raum auf `disconnected`.
  (raum as unknown as { state: string }).state = 'connected';
  raum.remoteParticipants.set('gegenstelle', {
    audioTrackPublications: new Map(spuren.map((track, i) => [`ton${i}`, { track }])),
    videoTrackPublications: new Map()
  } as never);
  return raum;
}

/** Die echte Kachel einhängen; der Rückgabewert hängt sie wieder aus. */
export function kachelEinhaengen(ton: RemoteAudioTrack, bild: RemoteVideoTrack): () => void {
  const ziel = document.createElement('div');
  document.body.appendChild(ziel);
  const kachel = mount(ScreenShareTile, {
    target: ziel,
    props: {
      channelId: '1',
      streamerId: null,
      track: bild,
      audioTrack: ton,
      name: 'Freigabe',
      identity: 'user-1',
      handy: false
    }
  });
  return () => {
    void unmount(kachel);
    ziel.remove();
  };
}
