/**
 * Das eigene Mikrofonsignal im Sprachkanal: Pegelmesser (roh und gesendet),
 * Sprech-Erkennung, Sendefilter (RNNoise/Gate/Verstärkung) und das Mithören.
 * Herausgelöst aus dem Voice-Store `livekit.svelte.ts`, der die Felder für die
 * Oberfläche weiterreicht (`voice.localMicLevel` …). Der Raum gehört dem
 * Store; hier wird er nur über `wirt.raum()` gelesen.
 */
import { Track, type Room } from 'livekit-client';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { settings } from '$lib/stores/settings.svelte';
import { applySinkId } from '$lib/audio/applySinkId';
import { ballistics, ClipHold, LEVEL_DECAY, PEAK_DECAY } from './meter';
import { createSendProcessor, type SendProcessorHandle, type SendProcessorMode } from './noiseFilter';
import { LocalMicAnalyser } from './localMicAnalyser';
import { SpeakingDetector } from './speakingDetector';
import { filterziel } from './filterwahl';

/** Was das Signal vom Voice-Store braucht. */
export interface SignalWirt {
  /** Der lebende Raum (`#room`), `null` ausserhalb eines Kanals. */
  raum(): Room | null;
  /** `localSpeaking` hat gewechselt — die eigene Zeile der Teilnehmerliste
   *  nachziehen. */
  sprechenGeaendert(spricht: boolean): void;
}

export class EigenesSignal {
  #wirt: SignalWirt;

  constructor(wirt: SignalWirt) {
    this.#wirt = wirt;
  }

  /** 0..1 instantaneous level of the local microphone (for the meter). */
  localMicLevel = $state(0);
  /** 0..1 peak-hold position of the raw mic — instant attack, ~800 ms decay.
   *  Rendered as a thin line over the RMS fill in the input-device meter. */
  localMicPeak = $state(0);
  /** True while raw-mic peaks exceed ~-1 dBFS (300 ms hold). Indicates an OS-
   *  level mic-gain problem — RNNoise and the makeup slider can't recover from
   *  pre-capture clipping, so this gets its own lamp distinct from sendClip. */
  localMicClip = $state(false);
  /** Whether the local user is currently speaking (RMS-based, not server). */
  localSpeaking = $state(false);
  /** 0..1 instantaneous level AFTER the noise filter + makeup gain — what's
   *  actually going into the encoder, i.e. what other listeners hear. */
  localSendLevel = $state(0);
  /** 0..1 peak-hold position of the send signal — same dBFS scaling as level,
   *  but follows transient peaks (instant attack, ~800 ms decay). Sprache hat
   *  hohen Crest-Faktor — der Peak liegt deutlich oberhalb der RMS-Anzeige
   *  und ist das was das Clip-Lämpchen tatsächlich triggert. */
  localSendPeak = $state(0);
  /** True while the post-gain send signal is clipping (~ -1 dBFS peak). */
  localSendClip = $state(false);
  /** "Hear yourself" while in a channel. Uses its OWN local mic capture (NOT the
   *  published track), so it keeps working while you're muted to the channel and
   *  never reaches the other people. Feedback risk on speakers (headphones
   *  advised). */
  selfMonitor = $state(false);
  #monitorEl: HTMLAudioElement | null = null;
  #monitorOutputId = '';
  // Dedicated local monitor capture + processor, independent of the published
  // mic. `#monitorGen` invalidates an in-flight async start when a newer
  // start/stop supersedes it (toggle, device swap, disconnect).
  #monitorStream: MediaStream | null = null;
  #monitorProc: SendProcessorHandle | null = null;
  #monitorGen = 0;

  /** True when the raw mic IS the send signal: no send-processor installed AND
   *  the self-monitor isn't running. In that mode the LocalMicAnalyser readings
   *  drive the send-side meters/ring directly (see the callbacks below); otherwise
   *  the post-processor tap (#feedSendMeter) owns them. */
  get #rawMicIsSendSignal(): boolean {
    return this.#sendProcessorMode === 'off' && !this.#monitorStream;
  }
  #localMic = new LocalMicAnalyser(
    (n) => {
      this.localMicLevel = n;
      // Mirror the input level into the send meters too, so the settings panel
      // shows sensible values and the clip lamp works in raw-mic mode.
      if (this.#rawMicIsSendSignal) this.localSendLevel = n;
    },
    (s) => {
      // Raw mic only drives the speaking ring when there is no send-processor.
      // With a processor installed, the post-gain tap (#onSendLevel →
      // #sendSpeakingDetector) is the source of truth — what listeners
      // actually hear, not what hit the mic.
      if (this.#rawMicIsSendSignal) this.#setLocalSpeaking(s);
    },
    (c) => {
      this.localMicClip = c;
      if (this.#rawMicIsSendSignal) this.localSendClip = c;
    },
    (p) => {
      this.localMicPeak = p;
      if (this.#rawMicIsSendSignal) this.localSendPeak = p;
    }
  );
  /** Drives `localSpeaking` from the post-processor send-tap RMS. Only fed
   *  while a send-processor (RNNoise+Gate or gain-only) is installed; raw-mic
   *  mode uses LocalMicAnalyser's own detector instead. */
  #sendSpeakingDetector = new SpeakingDetector((s) => this.#setLocalSpeaking(s));
  /** Clip-flag and timer for the send meter. */
  #sendClipHold = new ClipHold();

  /** Effective send-processor state. Drives applyNoiseFilter's swap decisions —
   *  re-evaluated against (noiseSuppression, inputMakeupGain≠1) on every call. */
  #sendProcessorMode: 'off' | SendProcessorMode = 'off';
  /** Concurrency guard for applyNoiseFilter — mirrors #connectGen pattern. */
  #filterGen = 0;
  /** Live-tune handle for the post-RNNoise hard gate (null when filter is off
   *  or the gain-only processor is the active one). */
  #noiseGateSetter: ((openDb: number) => void) | null = null;
  /** Live-tune handle for the post-gate makeup gain (null when no processor). */
  #makeupSetter: ((v: number) => void) | null = null;

  /**
   * (Re)apply the send-side processor to the local mic track based on the
   * current `noiseSuppression` and `inputMakeupGain` settings:
   *   NS = 'rnnoise_gated'                → RnnoiseGatedTrackProcessor (gain inside)
   *   NS = 'off', inputMakeupGain ≠ 1.0   → GainOnlyTrackProcessor
   *   NS = 'off', inputMakeupGain = 1.0   → no processor (raw mic published)
   * No-op when not connected / no mic track. Cheap when the target mode
   * matches the current one — just live-tunes the makeup gain.
   */
  async applyNoiseFilter(): Promise<void> {
    const room = this.#wirt.raum();
    if (!room) return;
    const gen = ++this.#filterGen;
    const gain = settings.audio.inputMakeupGain;
    // Rechnung geprüft in `voice/filterwahl.ts`.
    const ziel = filterziel({ wunsch: settings.audio.noiseSuppression, makeup: gain });
    const target: 'off' | SendProcessorMode = ziel === 'keiner' ? 'off' : ziel;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.audioTrack;
    if (!audioTrack) return;
    if (target === this.#sendProcessorMode) {
      // Same mode — just live-tune the makeup. Cheap, no track swap.
      this.#makeupSetter?.(gain);
      return;
    }
    try {
      // Neben dem eigenen Zaehler auch gegen den Raum pruefen: waehrend des
      // `await` kann aufgelegt worden sein. `#teardown` hat die Handles dann
      // schon fallen gelassen — schriebe man sie hier wieder hin, hielte
      // `#sendProcessorMode` beim naechsten Beitritt einen Prozessor fuer
      // installiert, den es nicht mehr gibt (Rauschunterdrueckung still aus).
      if (target === 'off') {
        await audioTrack.stopProcessor();
        if (gen !== this.#filterGen || this.#wirt.raum() !== room) return;
        this.#noiseGateSetter = null;
        this.#makeupSetter = null;
        this.resetSendLevel();
      } else {
        const handle = createSendProcessor(target, settings.audio.noiseGateThresholdDb, gain);
        await audioTrack.setProcessor(handle.processor);
        if (gen !== this.#filterGen || this.#wirt.raum() !== room) return;
        this.#noiseGateSetter = handle.setGateThreshold;
        this.#makeupSetter = handle.setMakeupGain;
        handle.setLevelTap(this.#onSendLevel);
      }
      this.#sendProcessorMode = target;
      // Processor swap replaces the published mediaStreamTrack — rebind raw meter.
      this.attachLocalAnalyser();
    } catch (e) {
      // Nach dem Auflegen keine Meldung mehr — der Fehler betrifft einen
      // Raum, den es nicht mehr gibt.
      if (gen !== this.#filterGen || this.#wirt.raum() !== room) return;
      this.clearProcessorHandles();
      this.resetSendLevel();
      toast.error(m.livekit_audio_path_update_failed(), {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  /** Live-update the post-RNNoise hard-gate open threshold (dB). No-op when
   *  the filter is off. Persisting is the caller's job. Mirrors onto the
   *  self-monitor's processor so the loopback reflects the slider live. */
  setNoiseGateThresholdDb(openDb: number): void {
    this.#noiseGateSetter?.(openDb);
    this.#monitorProc?.setGateThreshold(openDb);
  }

  /** Live-update the sender-side makeup gain on whatever processor is currently
   *  installed. If no processor is installed (NS off + previous gain was 1.0),
   *  the change won't be audible until applyNoiseFilter() reruns — typically
   *  via the slider's onchange handler. Persisting is the caller's job. Mirrors
   *  onto the self-monitor's processor so you HEAR the gain change while testing. */
  setInputMakeupGain(v: number): void {
    this.#makeupSetter?.(v);
    this.#monitorProc?.setMakeupGain(v);
  }

  /** Drop every send-processor handle back to the raw-mic baseline (no
   *  processor installed). Shared by applyNoiseFilter's stop/catch paths, the
   *  LocalTrackUnpublished handler, and #teardown. */
  clearProcessorHandles(): void {
    this.#sendProcessorMode = 'off';
    this.#noiseGateSetter = null;
    this.#makeupSetter = null;
  }

  attachLocalAnalyser(): void {
    if (!this.#wirt.raum()) return;
    this.#bindLocalMeter();
    this.syncMonitor();
  }

  /** Point the raw input meter at the live mic. While the self-monitor runs it
   *  owns the live capture (the published mic is muted/dead when you're muted to
   *  the channel), so the meter follows the monitor; otherwise it taps the
   *  published mic. Split from attachLocalAnalyser so the monitor start/stop can
   *  re-point the meter WITHOUT re-entering syncMonitor. */
  #bindLocalMeter(): void {
    const room = this.#wirt.raum();
    if (!room) {
      this.#localMic.detach();
      return;
    }
    const monTrack = this.#monitorStream?.getAudioTracks()[0] ?? null;
    if (monTrack) {
      this.#localMic.attach(monTrack);
      return;
    }
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.audioTrack;
    // Prefer the raw source MediaStreamTrack over the public getter, which
    // returns the post-processor (RNNoise) track — that attenuates the signal
    // noticeably and makes the meter look dead even at normal speech.
    // `_mediaStreamTrack` is protected in livekit-client; accessed via cast.
    const raw = (audioTrack as { _mediaStreamTrack?: MediaStreamTrack } | undefined)?._mediaStreamTrack;
    this.#localMic.attach(raw ?? audioTrack?.mediaStreamTrack ?? null);
  }

  /** Toggle "hear yourself" while in a channel + remember the output sink. */
  async setSelfMonitor(on: boolean, outputId: string): Promise<void> {
    this.selfMonitor = on;
    this.#monitorOutputId = outputId;
    this.syncMonitor();
  }

  /** Reconcile the local self-monitor with `selfMonitor` + connection state.
   *  Idempotent and deliberately INDEPENDENT of the published mic: the monitor
   *  has its own capture, so muting / publish changes don't tear it down — only
   *  toggling the setting off or disconnecting does. (Device swaps restart it via
   *  `setInputDevice`.) */
  syncMonitor(): void {
    if (!(this.selfMonitor && this.#wirt.raum())) {
      this.teardownMonitor();
      return;
    }
    if (this.#monitorStream) {
      void this.#applyMonitorSink(); // already running — just follow the output device
      return;
    }
    void this.#startMonitor();
  }

  /** Open a PRIVATE mic capture, run it through the same send processor (so you
   *  hear the gate/gain/RNNoise-processed signal, exactly like the settings mic
   *  test), and play it to the chosen output. Never published; survives mute. */
  async #startMonitor(): Promise<void> {
    const gen = ++this.#monitorGen;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.audio.inputDeviceId || undefined,
          echoCancellation: settings.audio.echoCancellation,
          autoGainControl: false, // Pulse regelt den Pegel selbst (Eingabe-Verstärker).
          noiseSuppression: false // the send processor does RNNoise itself.
        }
      });
    } catch {
      return; // permission denied / device gone — no monitor, no crash.
    }
    // Superseded while awaiting getUserMedia (toggled off, disconnected, swap)?
    if (gen !== this.#monitorGen || !this.selfMonitor || !this.#wirt.raum()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const track = stream.getAudioTracks()[0] ?? null;
    let outTrack: MediaStreamTrack | null = track;
    if (track) {
      try {
        const mode: SendProcessorMode =
          settings.audio.noiseSuppression !== 'off' ? 'rnnoise_gated' : 'gain_only';
        const proc = createSendProcessor(
          mode,
          settings.audio.noiseGateThresholdDb,
          settings.audio.inputMakeupGain
        );
        await proc.processor.init({ kind: Track.Kind.Audio, track });
        if (gen !== this.#monitorGen) {
          void proc.processor.destroy();
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.#monitorProc = proc;
        outTrack = proc.processor.processedTrack ?? track;
        // Drive the "Eingabe-Verstärkung" send meter from the monitor's own
        // processed signal, so it moves while you test even when muted.
        proc.setLevelTap(this.#feedSendMeter);
      } catch {
        /* worklet/WASM load failed → fall back to the raw mic */
      }
    }
    this.#monitorStream = stream;
    this.#monitorEl = new Audio();
    this.#monitorEl.autoplay = true;
    // Start MUTED, play, then unmute. The user gesture that opened the monitor
    // was consumed by the awaits above, so Chrome would block play() of audible
    // media — but muted media always autoplays, and unmuting an already-playing
    // element needs no gesture. (Same trick micTest uses.)
    this.#monitorEl.muted = true;
    this.#monitorEl.srcObject = new MediaStream(outTrack ? [outTrack] : []);
    await this.#applyMonitorSink();
    try {
      await this.#monitorEl.play();
    } catch {
      /* autoplay edge — plays once the stream delivers */
    }
    if (this.#monitorEl) this.#monitorEl.muted = false;
    // The monitor now owns a live capture — point the settings input meter at it
    // so the level moves while you test, even muted to the channel.
    this.#bindLocalMeter();
  }

  teardownMonitor(): void {
    this.#monitorGen++; // invalidate any in-flight start
    if (this.#monitorEl) {
      this.#monitorEl.pause();
      this.#monitorEl.srcObject = null;
      this.#monitorEl = null;
    }
    if (this.#monitorProc) {
      void this.#monitorProc.processor.destroy();
      this.#monitorProc = null;
    }
    this.#monitorStream?.getTracks().forEach((t) => t.stop());
    this.#monitorStream = null;
    // Monitor gone — clear its send-meter values and fall back to the published
    // mic for both meters (the live taps resume driving them).
    this.resetSendLevel();
    this.#bindLocalMeter();
  }

  async #applyMonitorSink(): Promise<void> {
    if (this.#monitorEl) await applySinkId(this.#monitorEl, this.#monitorOutputId);
  }

  /** RAF-callback from the processor's internal post-gain AnalyserNode tap.
   *  Same ballistics + dBFS scaling as LocalMicAnalyser so both meters look
   *  consistent. Clip flag is driven by raw peak amplitude > ~-1 dBFS with a
   *  300 ms hold so a single crackle stays visible. */
  #onSendLevel = (rms: number, peak: number): void => {
    // While the self-monitor runs, ITS processor owns the send meter (the
    // published processor reads silence when you're muted to the channel), so
    // ignore the published tap here to avoid the two fighting over the meter.
    if (this.#monitorStream) return;
    this.#feedSendMeter(rms, peak);
  };

  /** Drive the send meter + speaking ring from a post-processor level tap —
   *  shared by the published mic processor (#onSendLevel) and the self-monitor's
   *  processor (so the meter still moves while you test, muted). */
  #feedSendMeter = (rms: number, peak: number): void => {
    // Speaking ring tracks the post-processor signal — i.e. exactly what
    // other listeners receive. Above the gate's open-threshold (default
    // -45 dBFS at the gain node's input ⇒ louder at the tap after makeup)
    // means audio is genuinely flowing.
    this.#sendSpeakingDetector.feed(rms);
    // RMS bar (smooth) and peak-hold (slow decay) — same dBFS scale, different
    // decay; see #meterBallistics.
    this.localSendLevel = ballistics(rms, this.localSendLevel, LEVEL_DECAY);
    this.localSendPeak = ballistics(peak, this.localSendPeak, PEAK_DECAY);
    this.localSendClip = this.#sendClipHold.update(peak, performance.now());
  };

  resetSendLevel(): void {
    this.#sendClipHold.reset();
    this.localSendLevel = 0;
    this.localSendPeak = 0;
    this.localSendClip = false;
    // Send-tap stops feeding the detector when the processor goes away or the
    // mic gets disabled — without an explicit reset the detector would latch
    // on whatever state it had at the moment the feed stopped.
    this.#sendSpeakingDetector.reset();
  }

  #setLocalSpeaking(s: boolean): void {
    if (this.localSpeaking === s) return;
    this.localSpeaking = s;
    this.#wirt.sprechenGeaendert(s);
  }

  /** Erster Schritt im Abbau des Stores (`#teardown`): Mithören aus, Messer
   *  ab, Sendepegel und Sprech-Erkennung zurück. Die Sendefilter-Griffe
   *  fallen erst später (`clearProcessorHandles`), nach dem Raum. */
  abbauen(): void {
    this.selfMonitor = false;
    this.syncMonitor(); // stop + drop the monitor element
    this.#localMic.detach();
    this.resetSendLevel();
    this.#sendSpeakingDetector.reset();
  }

  /** Das eigene Mikrofon wurde stumm geschaltet (`setMicEnabled(false)`). */
  nachMikroAus(): void {
    this.resetSendLevel();
    // If the self-monitor is running, re-point the meter onto its live
    // capture so the level keeps moving while you're muted. With no monitor
    // (the normal case) this stays EXACTLY as before — detach the meter.
    if (this.#monitorStream) this.#bindLocalMeter();
    else this.#localMic.detach();
  }

  /** Die Mikrofon-Veröffentlichung ist weg (`LocalTrackUnpublished`). */
  nachMikroZurueckgezogen(): void {
    this.clearProcessorHandles();
    this.#localMic.detach();
    this.resetSendLevel();
    // Self-monitor is independent of the published track — leave it running.
  }

  /** Ein anderes Eingabegerät ist gewählt (`setInputDevice`). */
  nachGeraetewechsel(): void {
    // switchActiveDevice swapped the underlying mic track — rebind the raw meter.
    // The self-monitor has its OWN capture, so re-open it on the new device too
    // (tear down first → syncMonitor restarts it from the now-current device).
    this.teardownMonitor();
    if (this.#wirt.raum()) this.attachLocalAnalyser();
  }
}
