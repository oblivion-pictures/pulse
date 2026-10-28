/**
 * Kann dieser Browser einen H265-Track über WebRTC empfangen?
 *
 * Chromium bietet H265 beim Empfang nur an, wenn der Hardware-Decoder HEVC
 * meldet — einen Software-Decoder dafür hat es nicht. Die Empfangs-Liste von
 * `RTCRtpReceiver.getCapabilities` ist dieselbe, aus der das WHEP-Angebot
 * entsteht: fehlt H265 hier, antwortet MediaMTX mit „codecs not supported by
 * client". Gemessen 2026-10-28 (Chrome 156, Electron 43, Linux + RTX 5080):
 * ohne `VaapiOnNvidiaGPUs` kein H265 in der Liste und 400 von MediaMTX, mit
 * dem Schalter H265 in der Liste und 1080p60 dekodiert und angezeigt.
 *
 * Importfrei, damit `pnpm test:unit` die Datei direkt prüfen kann.
 */
export function h265Empfangbar(
  caps: RTCRtpCapabilities | null | undefined = globalThis.RTCRtpReceiver?.getCapabilities?.('video'),
): boolean {
  return caps?.codecs.some((c) => c.mimeType.toLowerCase() === 'video/h265') ?? false;
}
