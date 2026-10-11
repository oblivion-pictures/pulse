/**
 * Die Teilnehmerliste eines LiveKit-Raums, so wie die Oberfläche sie zeichnet:
 * eigene Zeile zuerst, die übrigen nach Namen. Gebaut wird sie im Voice-Store
 * (`livekit.svelte.ts::#refreshParticipants`, über `#scheduleRefresh`
 * entprellt); hier steht nur, was in einer Zeile steht. Schlichtes `.ts` ohne
 * Runes.
 */
import type { ConnectionQuality, LocalParticipant, Participant, Room } from 'livekit-client';
import { nameFor, userIdFromIdentity } from './identity';

export type VoiceParticipant = {
  /** LiveKit identity, e.g. `user-<snowflake>`. */
  identity: string;
  /** Display name (username), falls back to identity. */
  name: string;
  /** Our app user id parsed out of the identity, if possible. */
  userId: string | null;
  isLocal: boolean;
  isSpeaking: boolean;
  /** 0..1 instantaneous audio level (only meaningful while speaking). */
  audioLevel: number;
  /** Whether the participant's microphone track is muted. */
  micMuted: boolean;
  /** Whether this participant is publishing an unmuted camera track. */
  cameraOn: boolean;
  connectionQuality: ConnectionQuality;
};

/** Reused collator for participant-name sorting — far cheaper than calling
 *  String.localeCompare (which resolves a fresh collator) on every comparison. */
const NAME_COLLATOR = new Intl.Collator();

/** `eigenSpricht`/`sprichtFremd`: wer gerade spricht, misst der Store selbst
 *  (s. `isSpeaking` unten) — LiveKits Feld dafür wird nicht gelesen. */
export function teilnehmerListe(
  room: Room,
  eigenSpricht: boolean,
  sprichtFremd: (identity: string) => boolean
): VoiceParticipant[] {
  const out: VoiceParticipant[] = [];
  const toVP = (p: Participant, isLocal: boolean): VoiceParticipant => ({
    identity: p.identity,
    name: nameFor(p),
    userId: userIdFromIdentity(p.identity),
    isLocal,
    // Both sides RMS-driven — LiveKit's server active-speaker detection is
    // unreliable with AGC off (the default here, RNNoise replaces it).
    // Local: LocalMicAnalyser (raw) when no processor, else the
    // post-processor tap. Remote: AnalyserNode on the subscribed track.
    isSpeaking: isLocal ? eigenSpricht : sprichtFremd(p.identity),
    audioLevel: p.audioLevel ?? 0,
    micMuted: !p.isMicrophoneEnabled,
    cameraOn: p.isCameraEnabled,
    connectionQuality: p.connectionQuality
  });
  out.push(toVP(room.localParticipant as LocalParticipant, true));
  for (const p of room.remoteParticipants.values()) {
    out.push(toVP(p, false));
  }
  out.sort(eigeneZeileZuerstDannNachName);
  return out;
}

function eigeneZeileZuerstDannNachName(a: VoiceParticipant, b: VoiceParticipant): number {
  if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
  return NAME_COLLATOR.compare(a.name, b.name);
}
