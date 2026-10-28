/**
 * H.264-HW-Encode-Hint für Pulse-Screenshare (Chrome/Edge, Windows + macOS).
 *
 * Chrome listet H.264 in `RTCRtpSender.getCapabilities('video').codecs` mit
 * mehreren Profilen. Das Profil `profile-level-id=42e01f` (Constrained Baseline,
 * Level 3.1) bindet deterministisch an den OpenH264-Software-Encoder; die HW-
 * Pfade (MediaFoundation → NVENC/QSV/AMF auf Windows, VideoToolbox auf macOS)
 * werden nur für die übrigen Profile (`42001f` Baseline, `4d001f` Main,
 * `64001f` High) angesprochen.
 *
 * LiveKit-Client setzt keine Codec-Preferences — was Chrome im SDP-Offer in der
 * Default-Reihenfolge auflistet, gewinnt. Bei `42e01f` zuerst landet Screenshare
 * deshalb auf der CPU obwohl `videoCodec: 'h264'` konfiguriert ist. Beleg:
 * mediasoup-Discourse zeigt direkt `OpenH264` ↔ `42e01f`, `ExternalEncoder` ↔
 * `42001f` in den Chrome-WebRTC-Stats; vdo.ninja-Doku bestätigt das Mapping.
 *
 * Dieser einmalige, idempotente Hook auf `RTCPeerConnection.prototype.addTransceiver`
 * sortiert für jeden SENDENDEN Video-Transceiver die H.264-`42e01f`-Einträge ans
 * Ende der Codec-Preference. Andere Codecs (VP8/VP9/AV1) und Audio-Transceiver
 * bleiben unangetastet, die Reihenfolge ist sonst stable — entspricht also dem
 * Browser-Default minus dem SW-Profil ganz vorn.
 *
 * **`recvonly` bleibt unangetastet** (seit 2026-10-28). Die Liste kommt aus den
 * SENDE-Fähigkeiten; als Preference auf einem reinen Empfänger streicht sie
 * jeden Codec, den der Rechner dekodieren, aber nicht kodieren kann. Genau das
 * traf den WHEP-Zuschauer (`stream/whep.ts`): Linux + NVIDIA mit
 * `VaapiOnNvidiaGPUs` dekodiert H265, Chromium hat dort aber keinen
 * H265-Encoder — H265 fiel aus dem Angebot, MediaMTX antwortete
 * „codecs not supported by client" (MediaMTX-Log, Electron-Dev-App).
 */

type CodecCap = RTCRtpCodec & { sdpFmtpLine?: string };

let installed = false;

/** Idempotent. Sicher mehrfach aufzurufen; sicher in Browsers ohne
 *  `getCapabilities`/`setCodecPreferences` (No-op). */
export function installH264HwHint(): void {
  if (installed) return;
  if (typeof RTCPeerConnection === 'undefined') return;
  if (typeof RTCRtpSender === 'undefined' || !('getCapabilities' in RTCRtpSender)) return;
  const proto = RTCPeerConnection.prototype;
  const orig = proto.addTransceiver;
  if (typeof orig !== 'function') return;

  proto.addTransceiver = function patched(
    this: RTCPeerConnection,
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit
  ): RTCRtpTransceiver {
    const transceiver = orig.call(this, trackOrKind as MediaStreamTrack, init);
    const kind =
      typeof trackOrKind === 'string'
        ? trackOrKind
        : (trackOrKind as MediaStreamTrack | undefined)?.kind;
    // Empfänger kodieren nicht — und die Sende-Liste darunter kennt nicht jeden
    // Codec, den sie dekodieren (s. Kopf).
    if (kind !== 'video' || init?.direction === 'recvonly') return transceiver;
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      const codecs = caps?.codecs as CodecCap[] | undefined;
      if (!codecs?.length) return transceiver;
      if (typeof transceiver.setCodecPreferences !== 'function') return transceiver;
      transceiver.setCodecPreferences(deprioritizeCbpH264(codecs));
    } catch {
      // setCodecPreferences kann InvalidAccessError werfen wenn die Liste nicht
      // exakt eine Teilmenge der Capabilities ist (Browser-spezifisch streng).
      // Fallback = Default-Order; in dem Fall bleibt's bei OpenH264 auf der CPU,
      // ohne weiteren Schaden.
    }
    return transceiver;
  };

  installed = true;
}

function deprioritizeCbpH264(codecs: CodecCap[]): CodecCap[] {
  const cbp: CodecCap[] = [];
  const rest: CodecCap[] = [];
  for (const c of codecs) {
    if (isCbpH264(c)) cbp.push(c);
    else rest.push(c);
  }
  return [...rest, ...cbp];
}

function isCbpH264(c: CodecCap): boolean {
  if (c.mimeType.toLowerCase() !== 'video/h264') return false;
  return /profile-level-id=42e01f/i.test(c.sdpFmtpLine ?? '');
}
