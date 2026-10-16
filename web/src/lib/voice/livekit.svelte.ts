import {
  ConnectionState,
  LocalVideoTrack,
  Room,
  Track
} from 'livekit-client';
import type {
  AudioCaptureOptions,
  RoomOptions,
  ScreenShareCaptureOptions,
  TrackPublishOptions
} from 'livekit-client';
import { getVoiceToken } from '$lib/api/voice';
import { ApiError } from '$lib/api/client';
import { voiceState, registerVoiceActions } from './state.svelte';
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
import { RemoteAudioElements } from './audioElements';
import { setVoiceMediaSession, clearVoiceMediaSession } from './mediaSession';
import { settings, type SpatialMode } from '$lib/stores/settings.svelte';
import { effectiveVoiceBitrateMaxKbps } from '$lib/stream/guildLimits';
import { AudioDevices } from './audioDevices.svelte';
import { applySinkId } from '$lib/audio/applySinkId';
import { startAudioAbbruchfest } from '$lib/audio/abspielen';
import { RemoteSpeakingTracker } from './remoteSpeakingTracker';
import { ScreenShareTracks, type ScreenShareTrack } from './screenTracks.svelte';
import { CameraTracks, type CameraTrack } from './cameraTracks.svelte';
import {
  acquireWindowAudioStream,
  canUseWindowAudioCapture
} from './windowAudioCapture';
import { installH264HwHint } from './h264HwHint';
import { quelleZuruecknehmen, raumVerwerfen } from './abbruch';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { guilds } from '$lib/stores/guilds.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { saveVoiceResume, clearVoiceResume, type VoiceResume } from './resume';
import { AbbauWache } from './abbauWache';
import { raumVerdrahten, type RaumHaken } from './raumEreignisse';
import { bildschirmFehlerMelden, bildschirmPlan, FensterTonUmweg } from './bildschirmFreigabe';
import { teilnehmerListe, type VoiceParticipant } from './teilnehmer';
import { EigenesSignal } from './eigenesSignal.svelte';
import { kameraSetzen, kameraWechseln } from './eigeneKamera';
import { gateway } from '$lib/ws/connection';
import { sounds } from '$lib/sounds/engine';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { acquireWakeLock } from '$lib/platform/wakeLock';
import { istAblehnung, standMerken } from '$lib/platform/berechtigung.svelte';
import { isIosWebKit, isMobile } from '$lib/platform/runtime';
import { nativerSprachwegBefund } from '$lib/platform/iosSprache';
import { NativerRaum } from './nativerRaum.svelte';
import type { NutzerWahl } from './nativAbgleich';
import type { StartAbgleich } from './startBeitritt';
import { setVoiceActive, maybeSendAudioDiagnostic } from '$lib/platform/audioRoute';
import { tonSystemFilterBeobachten, tonVoice } from '$lib/platform/iosTon';
import { sidecar } from '$lib/stream/sidecar';
import { runningStreamSlots } from '$lib/stream/state.svelte';

export type { ScreenShareTrack, CameraTrack };
export type { VoiceParticipant } from './teilnehmer';

// Einmalig vor dem ersten Room-Aufbau: H.264-`42e01f`-Profile in den
// Codec-Preferences ans Ende, damit Chrome auf Windows MediaFoundation (NVENC/
// QSV/AMF) statt OpenH264 nimmt. Details siehe `h264HwHint.ts`.
installH264HwHint();

/** Trailing-debounce window for #scheduleRefresh. LiveKit can fire
 *  ActiveSpeakersChanged / ConnectionQualityChanged (and the ParticipantConnected +
 *  TrackSubscribed×N burst) across consecutive macrotasks; rebuilding the full
 *  participant array (sort + Svelte re-render of every tile) on each one re-renders
 *  several times per second in lively rooms. 50 ms collapses a burst into one rebuild
 *  — fast enough that a speaker change still feels instant. */
const PARTICIPANT_REFRESH_DEBOUNCE_MS = 50;

/** Maps a `setMicrophoneEnabled`/getUserMedia failure to a user-facing message
 *  — never the raw browser string (e.g. Chromium's unlocalized "Requested
 *  device not found"). `NotFoundError`/`OverconstrainedError` mean no device
 *  matched the (possibly stale, persisted) deviceId — most commonly because
 *  no microphone is connected at all. */
function micErrorMessage(e: unknown): string {
  if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
    return m.livekit_microphone_not_found();
  }
  return m.livekit_microphone_access_failed();
}

class VoiceRoom {
  /** The id of the channel we are connected to (or connecting to). */
  channelId = $state<string | null>(null);
  /** Human-readable channel name for UI; set by the caller on connect. */
  channelName = $state<string | null>(null);
  state = $state<ConnectionState>(ConnectionState.Disconnected);
  /** Last error message from a failed connect, surfaced to the UI. */
  error = $state<string | null>(null);
  /** Timestamp of the latest connect() start (0 = nie). Der Stuhl-Übernahme-
   *  Wächter im voice_disconnect-Handler erkennt daran den ECHO des eigenen
   *  Joins: der Übernahme-Wurf wird beim BEITRETEN ausgelöst und an alle
   *  Geräte gebroadcastet — das joinende fängt ihn selbst ab und darf sich
   *  deswegen nicht selbst abreißen. Kein $state: nur im WS-Handler gelesen,
   *  nie gerendert. */
  joinStartedAt = 0;

  participants = $state<VoiceParticipant[]>([]);

  /** Ein laufendes natives Auflegen (B2, `abbauWache.ts`). */
  #nativAbbau = new AbbauWache();

  /** Der native Weg (iOS-Hülle) — eigene Datei, s. `nativerRaum.svelte.ts`.
   *  Die Haken sind die privaten Stellen dieses Stores, die er braucht. */
  #nativ = new NativerRaum(this, {
    melden: () => this.#publishSelfState(),
    abbauen: () => this.#teardown(),
    wachHalten: () => this.#ensureWakeLock(),
    vorTaubSetzen: (an) => {
      this.#micEnabledBeforeDeafen = an;
    },
    aktuell: (gen) => gen === this.#connectGen
  });

  /** Läuft dieser Raum nativ (iOS-Hülle)? Treibt die Weichen in der
   *  Oberfläche: dort, wo der Web-Weg eine Videokachel zeichnet, gibt es auf
   *  dem nativen Weg nur den Griff in die native Ansicht. */
  get nativ(): boolean {
    return this.#nativ.aktiv;
  }

  /** Steht die native Kanalansicht gerade über der Web-App? Solange sie
   *  liegt, ist die Web-Leiste verdeckt; fällt sie weg, bietet die Leiste den
   *  Griff zurück an, und der liest dieses Feld. */
  /** Hat der Mikrofon-Wächter der Hülle aufgegeben (nur iOS-nativ)? */
  get nativMikroTot(): boolean {
    return this.#nativ.mikroTot;
  }

  /** „Erneut verbinden" nach einem toten Mikrofon (`nativerRaum.svelte.ts`). */
  nativNeuVerbinden(): Promise<void> {
    return this.#nativ.neuVerbinden();
  }

  get nativeAnsichtOffen(): boolean {
    return this.#nativ.ansichtOffen;
  }

  /** Local mic on/off (publish state) + "Deafen" (locally mute all remote
   *  audio). Die Signale leben in `voiceState` ($lib/voice/state.svelte), damit
   *  TraySync/ShortcutHost sie ohne diesen Import — und damit ohne
   *  livekit-client im Root-Layout — lesen können. Die Accessors halten alle
   *  internen this.micEnabled/this.deafened-Lese-/Schreibzugriffe unverändert. */
  get micEnabled(): boolean {
    return voiceState.micEnabled;
  }
  set micEnabled(on: boolean) {
    voiceState.micEnabled = on;
  }
  get deafened(): boolean {
    return voiceState.deafened;
  }
  set deafened(on: boolean) {
    voiceState.deafened = on;
  }

  /** Whether the local participant is currently sharing their screen. */
  isScreenSharing = $state(false);
  /** Whether the local participant is currently publishing a camera track. */
  isCameraOn = $state(false);
  /** The local user's own published camera track — drives the self-preview
   *  tile. `null` while the camera is off. Without this the user never sees
   *  their own webcam (only remote cams are rendered). */
  localCameraTrack = $state<LocalVideoTrack | null>(null);
  /** Which physical camera the local cam uses. Toggled by flipCamera() —
   *  matters on phones (front 'user' vs back 'environment'). */
  cameraFacing = $state<'user' | 'environment'>('user');

  /** True when the browser blocked audio playback (autoplay policy). */
  audioBlocked = $state(false);
  /** WARUM die Wiedergabe nicht anlief — roh, so wie WebKit es nennt.
   *
   *  Steht in der Überlagerung mit drin, weil der Käfer-Dialog (das eigentliche
   *  Diagnose-Gedächtnis) auf dem Handy nicht erreichbar ist: er hängt an
   *  `UserFooter` → `SidebarFooter`, und die ist auf Mobil ausgeblendet. Eine
   *  Diagnose, an die man dort nicht herankommt, wo der Fehler auftritt, ist
   *  keine. Leer, solange nichts abgelehnt wurde. */
  audioBlockGrund = $state('');

  /** Pegel, Sprech-Erkennung, Sendefilter und Mithören des eigenen Mikrofons
   *  (`eigenesSignal.svelte.ts`, dort die Doku je Feld). Die Oberfläche liest
   *  die Felder weiter hier am Store. */
  #signal = new EigenesSignal({
    raum: () => this.#room,
    sprechenGeaendert: (s) => this.#eigenesSprechenSpiegeln(s)
  });
  get localMicLevel(): number {
    return this.#signal.localMicLevel;
  }
  get localMicPeak(): number {
    return this.#signal.localMicPeak;
  }
  get localMicClip(): boolean {
    return this.#signal.localMicClip;
  }
  /** Schreibbar, weil der native Weg es beim Zurücksetzen löscht. */
  get localSpeaking(): boolean {
    return this.#signal.localSpeaking;
  }
  set localSpeaking(s: boolean) {
    this.#signal.localSpeaking = s;
  }
  get localSendLevel(): number {
    return this.#signal.localSendLevel;
  }
  get localSendPeak(): number {
    return this.#signal.localSendPeak;
  }
  get localSendClip(): boolean {
    return this.#signal.localSendClip;
  }
  get selfMonitor(): boolean {
    return this.#signal.selfMonitor;
  }

  #screenShare = new ScreenShareTracks();
  #cameras = new CameraTracks();
  /** Der Windows-11-Umweg für den Fenster-Ton (`bildschirmFreigabe.ts`). */
  #fensterTon = new FensterTonUmweg();
  #room: Room | null = null;
  #audioEls = new RemoteAudioElements();
  #devices = new AudioDevices(this.#audioEls, () => this.applyNoiseFilter());
  /** Per-remote-participant speaking state, computed client-side from the
   *  subscribed audio track. */
  #remoteSpeaking = new RemoteSpeakingTracker((identity, speaking) =>
    this.#onRemoteSpeakingChange(identity, speaking)
  );
  /** Die privaten Stellen, an die `raumEreignisse.ts` die LiveKit-Ereignisse
   *  eines Raums weiterreicht. */
  #raumHaken: RaumHaken = {
    lebt: (room) => this.#room === room,
    abbauen: () => this.#teardown(),
    neuZeichnen: () => this.#scheduleRefresh(),
    geraeteAuffrischen: () => void this.#devices.refresh(this.#room),
    mikroVeroeffentlicht: () => this.#signal.attachLocalAnalyser(),
    mikroZurueckgezogen: () => this.#signal.nachMikroZurueckgezogen(),
    kameras: this.#cameras,
    bildschirme: this.#screenShare,
    tonElemente: this.#audioEls,
    fremdesSprechen: this.#remoteSpeaking
  };

  /** Mic state captured at deafen-on so un-deafen can restore it. */
  #micEnabledBeforeDeafen = false;
  /** Mic state captured at force-mute-on so a force-unmute can restore it.
   *  Mirrors #micEnabledBeforeDeafen — without it an admin-unmute hands the
   *  publish permission back but the local mic track stays torn down, so the
   *  user appears live while transmitting nothing. */
  #micEnabledBeforeForceMute = false;
  /** Tracks the last applied admin force-mute so applyForceMute only fires on
   *  the actual on→off / off→on transition (the WS event carries full state). */
  #forceMuted = false;
  /** Release fn for the screen wake-lock held while connected on mobile (so the
   *  phone's auto-lock can't blank the screen and suspend the outgoing mic).
   *  Null when not held. */
  #releaseWakeLock: (() => void) | null = null;
  /** Stable visibilitychange ref (for add/removeEventListener). On return to the
   *  foreground we recover a mic the OS muted while we were backgrounded. */
  #onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    void this.#recoverMicAfterForeground();
  };
  #teardownDone = false;
  /** Monotonic connect counter. Each `connect()` captures its value; an
   *  await that returns to find `#connectGen` moved on knows a newer
   *  connect (or a disconnect) superseded it and bails — without this a
   *  fast double-click builds two `Room`s and orphans the first.
   *  Hochgezaehlt wird an drei Stellen: `connect()` (neuer Aufbau),
   *  `disconnect()` (ausdrueckliches Auflegen) und `#teardown()` (Abbau von
   *  aussen, etwa Kick oder Netzverlust). Nur `connect()` hochzuzaehlen war
   *  ein Loch: wer waehrend des Verbindens auflegte, wurde vom
   *  zurueckkehrenden `connect()` wieder in den Kanal gesetzt — samt
   *  Mikrofon-Veroeffentlichung auf einem bereits abgebauten Raum. */
  #connectGen = 0;
  /** Der Zaehlerstand, den ein ausdrueckliches `disconnect()` entwertet hat.
   *  Trennt „der Nutzer hat aufgelegt" von „die Verbindung ist gescheitert":
   *  nur im ersten Fall schweigt `connect()`, im zweiten meldet es weiterhin
   *  den Fehler. */
  #abbruchGen = -1;
  /** Pending trailing-debounce timer for #refreshParticipants; null when idle.
   *  Coalesces bursts of LiveKit events (ParticipantConnected + TrackSubscribed×N +
   *  ConnectionQualityChanged×N) into a single rebuild so Svelte re-renders once.
   *  Cleared in #teardown. */
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** One-shot timer for the post-join audio-routing diagnostic (Android). Cleared
   *  in #teardown so a channel switch within the delay doesn't fire a stale (and
   *  post-release, misleading) snapshot. */
  #audioDiagTimer: ReturnType<typeof setTimeout> | null = null;

  /** Remote screen-share tracks currently active in the room. */
  get screenTracks(): ScreenShareTrack[] {
    return this.#screenShare.list;
  }

  /** Local screen-share video track (whatever path published it: regular
   *  LiveKit setScreenShareEnabled or the Win11 windowAudio-bypass) — both
   *  end up as a publication with source === ScreenShare on the local
   *  participant. Returns null when not sharing. Used by the streamer-side
   *  stats overlay to read outbound-rtp + encoderImplementation. */
  get localScreenShareTrack(): LocalVideoTrack | null {
    const room = this.#room;
    if (!room || !this.isScreenSharing) return null;
    const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    return (pub?.videoTrack as LocalVideoTrack | undefined) ?? null;
  }

  /** Remote camera (webcam) tracks currently active in the room. */
  get cameraTracks(): CameraTrack[] {
    return this.#cameras.list;
  }

  /** Available audio input/output devices + current selections (for the pickers). */
  get inputDevices(): MediaDeviceInfo[] {
    return this.#devices.inputs;
  }
  get outputDevices(): MediaDeviceInfo[] {
    return this.#devices.outputs;
  }
  get selectedInputDeviceId(): string {
    return this.#devices.selectedInputId;
  }
  get selectedOutputDeviceId(): string {
    return this.#devices.selectedOutputId;
  }

  /** Push-to-talk active when settings.voice.pttMode is true. Mirrors the store. */
  get pttMode(): boolean {
    return settings.voice.pttMode;
  }

  /** Sound-playback context for the current channel's guild — used by the
   *  self join/leave/mute/deafen cues. */
  get #soundCtx(): { guildId: string | null } {
    return { guildId: guilds.guildIdForChannel(this.channelId ?? '') };
  }

  get connected(): boolean {
    return this.state === ConnectionState.Connected;
  }
  get connecting(): boolean {
    return this.state === ConnectionState.Connecting || this.state === ConnectionState.SignalReconnecting;
  }

  /** Connect to the LiveKit room backing the given voice channel.
   *  `opts.startMuted` / `opts.startDeafened` lassen den Mic beim Join aus bzw.
   *  starten deafened — genutzt vom Voice-Resume nach einem Reload, um den
   *  vorherigen Zustand wiederherzustellen statt blind „live on join". */
  async connect(
    channelId: string,
    channelName: string,
    opts: { startMuted?: boolean; startDeafened?: boolean; micBeforeDeafen?: boolean } = {}
  ): Promise<void> {
    // Mic state to restore into #micEnabledBeforeDeafen when this connect carries
    // a deafen across a channel switch (teardown wipes it) or a reload-resume
    // (opts.micBeforeDeafen — otherwise un-deafen would always stay muted).
    let micBeforeDeafen = opts.micBeforeDeafen ?? false;
    // B2: ein natives Auflegen läuft noch — erst danach beitreten, sonst
    // räumt sein spätes `#teardown` diesen Beitritt ab (`abbauWache.ts`).
    if (this.#nativAbbau.laeuft) await this.#nativAbbau.abwarten();
    // **`this.nativ` muss hier mitgeprüft werden.** Auf dem nativen Weg
    // bleibt `#room` für immer leer — der Wächter griff dort also NIE. Folge:
    // ein Kanalwechsel auf iOS lief ohne `disconnect({reason:'user'})`, also
    // ohne das Beenden einer gehosteten Watch-Party und ohne das Überführen
    // von Stumm und Taub in den neuen Kanal (die Hülle trennt den alten Raum
    // in `beitreten` selbst, deshalb fiel es nicht als Abriss auf, sondern nur
    // als „die Wahl ist weg").
    if ((this.#room || this.nativ) && (this.connected || this.connecting)) {
      if (this.channelId === channelId) return;
      // Channel switch keeps the user's mute/deafen choice (Discord-style) —
      // #teardown resets both, so fold them into opts before disconnecting.
      micBeforeDeafen = this.#micEnabledBeforeDeafen;
      // Hält ein Anruf den nativen Kanal an, reist die WAHL des Nutzers mit,
      // nicht das „stumm und taub" der Pause (B3, `nativAbgleich.ts`).
      const wahl = this.#wahl();
      opts = {
        startMuted: opts.startMuted ?? !wahl.mikro,
        startDeafened: opts.startDeafened ?? wahl.taub,
      };
      // Switching channels = user-driven leave of the old one. End any
      // hosted watch party there.
      await this.disconnect({ reason: 'user' });
    }
    // Claim this connect. Any earlier connect still in flight (its `#room`
    // not yet assigned, so the guard above couldn't see it) will notice the
    // bump after its next await and abort instead of building a second Room.
    const gen = ++this.#connectGen;
    this.error = null;
    this.channelId = channelId;
    this.channelName = channelName;
    this.joinStartedAt = Date.now();
    this.state = ConnectionState.Connecting;

    this.#teardownDone = false;
    let resp;
    try {
      resp = await getVoiceToken(channelId, 'voice');
    } catch (e) {
      // Only roll back shared state if we're still the current connect —
      // otherwise a newer connect already owns `this.*`.
      if (gen === this.#connectGen) {
        this.state = ConnectionState.Disconnected;
        this.channelId = null;
        this.channelName = null;
        // 409 = Channel voll (Benutzerlimit erreicht) → klare Meldung statt
        // des rohen "voice channel is full"-Detail-Strings vom Server.
        if (e instanceof ApiError && e.status === 409) {
          this.error = m.voice_channel_full();
        } else if (e instanceof Error) {
          this.error = e.message;
        } else {
          this.error = m.livekit_token_request_failed();
        }
      }
      throw e;
    }
    // Superseded during the token fetch — drop out silently before building
    // a Room. The newer connect owns the UI state from here.
    if (gen !== this.#connectGen) return;

    // **iOS: ab hier übernimmt die Hülle.** Alles darunter baut auf einem
    // JS-`Room` auf, den es auf dem nativen Weg nicht gibt. Die Weiche sitzt
    // bewusst NACH dem Token-Abruf: die Anmeldung bleibt im Web, nativ
    // bekommt nur `wsUrl` und `token` gereicht.
    // **Welcher Weg genommen wurde, steht im Speicher — und das hat einen
    // Grund.** Am 2026-10-10 liefen vier Messläufe unbemerkt auf dem ALTEN
    // Weg, weil ein vergessener Schalter ihn abgeschaltet hatte. Von aussen
    // sah alles richtig aus; nur die Zahlen gehörten zu etwas anderem. Seither
    // sagt die App, wofür sie sich entschieden hat — und seit dem 2026-10-11
    // auch, WARUM (`grund`, bei einem zu alten App-Bau samt `fehlen`: welche
    // Methoden ihm fehlen; s. `iosSpracheWeiche.ts`).
    const weiche = nativerSprachwegBefund();
    try {
      localStorage.setItem(
        'pulse.diag.weiche',
        JSON.stringify({ zeit: new Date().toISOString(), ...weiche })
      );
    } catch {
      /* Diagnose darf nie der Grund sein, dass ein Beitritt scheitert. */
    }
    if (weiche.nativ) {
      // `this.micEnabled` wird erst weiter unten gesetzt und trägt hier noch
      // den Stand des vorigen Kanals. Die Absicht steht in `opts`.
      await this.#nativ.verbinden(resp.ws_url, resp.token, channelId, channelName, gen, {
        stumm: Boolean(opts.startMuted || opts.startDeafened) || this.pttMode,
        taub: Boolean(opts.startDeafened),
        micBeforeDeafen
      });
      return;
    }

    const room = new Room(this.#roomOptions());
    // Vor room.connect() (dort wird das Ereignis verdrahtet), s. Helfer.
    startAudioAbbruchfest(room);
    this.#room = room;
    this.#applyPlaybackSettings();
    // Vor room.connect() verdrahten, sonst gehen Handshake-Events verloren.
    // `.on()` dedupliziert nicht — genau einmal aufrufen.
    raumVerdrahten(room, this, this.#raumHaken);

    // Android: force MODE_IN_COMMUNICATION BEFORE room.connect(). LiveKit creates
    // the remote <audio> elements during the handshake (TrackSubscribed → attach →
    // play()) and Android pins an already-running AudioTrack to its current stream
    // — setting the mode only AFTER connect (the old order) left those tracks on the
    // media channel (A2DP) → "too quiet in the car". Awaiting here gives the native
    // mode switch a head start before any track exists. No-op off Capacitor-Android;
    // cleared again in #teardown on leave.
    await setVoiceActive(true);
    // iOS: dieselbe Regel wie oben fuer Android — LiveKit verlangt eine
    // eingerichtete UND aktive `AVAudioSession`, bevor ein Mikrofon
    // veroeffentlicht wird (`platform/iosTon.ts`).
    //
    // **Hier stand bis zum 2026-10-10 eine falsche Begruendung**, und sie
    // kostete einen Tag: `AVAudioSession.setActive` blockiere den
    // Hauptthread, deshalb duerfe nicht gewartet werden. Am Geraet
    // nachgemessen trifft das nicht zu — Capacitor arbeitet Plugin-Rufe auf
    // einer eigenen SERIELLEN Warteschlange ab (`DispatchQueue(label:
    // "bridge")`, `CapacitorBridge.swift`), und jede einzelne Messung meldete
    // `haupt=nein`. `setCategory` braucht 3–8 ms, `setActive(true)` 63–309 ms.
    //
    // Die App fror wirklich ein, nur aus einem anderen Grund: eine
    // Rueckkopplung richtete die Session 4–10 mal pro Sekunde neu ein, und
    // weil jene Warteschlange seriell ist, stand danach jeder Plugin-Ruf
    // dahinter. Nicht der Hauptthread war belegt, sondern die Bruecke. Die
    // Rueckkopplung ist seit demselben Tag an der Wurzel beseitigt
    // (Weg-Vergleich statt Zeitfrist, s. `wegAngewandt` in `iosTon.ts`) —
    // damit kostet dieses `await` im gemessenen schlechtesten Fall rund eine
    // Drittelsekunde und stellt die Reihenfolge sicher, auf die es ankommt.
    await tonVoice('sprachkanal', true);

    // Aufgelegt, waehrend der Ruf-Modus gesetzt wurde — gar nicht erst
    // verbinden. Ohne diesen Wachposten baut der Handschlag den Raum noch
    // vollstaendig auf, bevor der naechste Vergleich ihn wieder abraeumt.
    if (gen !== this.#connectGen) {
      await this.#abbruch(room);
      return;
    }

    try {
      await room.connect(resp.ws_url, resp.token);
    } catch (e) {
      // Hat der Nutzer selbst aufgelegt, ist das Scheitern erwuenscht — dann
      // keine Fehlermeldung. Ein echter Verbindungsfehler meldet weiter.
      if (gen === this.#abbruchGen) {
        await this.#abbruch(room);
        return;
      }
      this.error = e instanceof Error ? e.message : m.livekit_connection_failed();
      this.#teardown();
      throw e;
    }

    // Superseded while the LiveKit handshake ran — tear down the room we just
    // built so it doesn't linger connected + mic-publishing as an orphan.
    if (gen !== this.#connectGen) {
      await this.#abbruch(room);
      return;
    }

    // Startversuch fuer die Wiedergabe. Der Kommentar hier behauptete bis zum
    // 2026-10-09, man sei "still inside the user gesture that triggered
    // connect()" — das haelt nicht: zwischen Klick und dieser Zeile liegen die
    // awaits des LiveKit-Handshakes, und WebKit hat die Nutzeraktivierung
    // laengst verworfen. Auf iOS scheitert deshalb auch LiveKits stummes
    // Hilfselement, und die spaeter eintreffenden fremden Tonspuren bleiben
    // gesperrt — dagegen steht der "Audio aktivieren"-Knopf (unblockAudio),
    // der in der Geste laeuft. Auf Chromium genuegt eine frueher erteilte
    // Interaktion mit der Seite, dort fuehrt der Weg hier zum Ziel.
    try {
      await room.startAudio();
    } catch {
      // Eine Autoplay-Sperre (NotAllowedError) wirft hier; ein überholter
      // Versuch (AbortError) kommt gar nicht erst an, `startAudioAbbruchfest`
      // wiederholt ihn. Den Zustand liest die Zeile unten aus
      // `room.canPlaybackAudio`.
    }

    // Re-check generation: a channel switch may have started while startAudio
    // was awaiting. If so, the new connect already owns this.#room and the
    // shared state — bail without clobbering it.
    if (gen !== this.#connectGen) {
      await this.#abbruch(room);
      return;
    }

    this.state = room.state;
    // Frischer Raum, noch keine fremde Spur — auf iOS-WebKit heisst das:
    // nichts ist gesperrt. LiveKits Urteil gilt dort NICHT, s.
    // `livekitWiedergabeUebernehmen` in `raumEreignisse.ts`. Desktop und
    // Android wie vorher.
    this.audioBlocked = isIosWebKit() ? false : !room.canPlaybackAudio;
    voiceState.channelId = channelId;
    voiceState.connected = room.state === ConnectionState.Connected;
    this.#refreshParticipants();
    // Setter erneut anwenden (idempotent): die Settings können sich während des
    // connect-await geändert haben.
    this.#applyPlaybackSettings();

    // micEnabled synchron setzen (vor dem await) — sonst lesen Listener
    // (TraySync, Buttons) transient connected=true + micEnabled=false und das
    // Tray blitzt rot auf. Bei API-Fehler wird unten auf false zurückgesetzt.
    const startMuted = opts.startMuted || opts.startDeafened;
    this.micEnabled = !this.pttMode && !startMuted;

    await this.#devices.refresh(room);

    // Re-check again after devices.refresh() — same risk of a concurrent
    // connect that replaced this.#room during the await.
    if (gen !== this.#connectGen) {
      await this.#abbruch(room);
      return;
    }

    // Eigentlicher Mic-Publish — `micEnabled` ist oben schon synchron gesetzt;
    // wir machen hier nur das LiveKit-API + applyNoiseFilter/attachLocalAnalyser
    // und rollbacken `micEnabled` im Fehlerfall.
    if (this.micEnabled) {
      // Entscheidung 2e: ein Server-Force-Mute (Override) lehnt den Publish
      // serverseitig ab — der Connect meldete dann "Mikrofon-Zugriff
      // fehlgeschlagen", dabei ist der Browser-Zugriff gar nicht das Problem.
      // Bekannter Override → klare Ansage statt generischem Geräte-Fehler.
      if (this.#selfOverride().muted) {
        this.micEnabled = false;
        this.error = m.voice_admin_mute_aktiv();
        return;
      }
      try {
        await room.localParticipant.setMicrophoneEnabled(true, this.#audioCaptureDefaults());
        // Der Zugriff hat geklappt — also liegt die Mikrofon-Erlaubnis vor.
        // Gemerkt, damit die Vorerklärung (iOS-Punkt 36) nicht bei jedem
        // Beitritt wiederkommt: eine WKWebView gibt über den Stand keine
        // Auskunft, der Ausgang ist der einzige Beleg
        // (`platform/berechtigung.svelte.ts`).
        standMerken('mikrofon', 'erteilt');
        // Der teuerste Abbruchpunkt: hier existiert die Mikrofonspur bereits.
        // Nur zurueckkehren wuerde sie offen zuruecklassen — #abbruch nimmt sie
        // zurueck und stoppt sie, bevor der Raum getrennt wird.
        if (gen !== this.#connectGen) {
          await this.#abbruch(room);
          return;
        }
        await this.applyNoiseFilter();
        this.#signal.attachLocalAnalyser();
      } catch (e) {
        if (gen !== this.#connectGen) {
          await this.#abbruch(room);
          return;
        }
        this.micEnabled = false;
        // Nur eine echte ABLEHNUNG wird gemerkt — ein fehlendes oder belegtes
        // Gerät sagt über die Erlaubnis nichts.
        if (istAblehnung(e)) standMerken('mikrofon', 'verweigert');
        // Auch hier: Override-Abweisung (LiveKit-Grant ohne Mic) klar benennen.
        this.error = this.#selfOverride().muted
          ? m.voice_admin_mute_aktiv()
          : micErrorMessage(e);
      }
    }
    // Re-check again after setMicEnabled() — same risk of a concurrent connect
    // that replaced this.#room during the await.
    if (gen !== this.#connectGen) {
      await this.#abbruch(room);
      return;
    }
    // Restore deafen BEFORE publishing so peers see the right state immediately.
    // setDeafened auch mutet den Mic — daher nach dem (übersprungenen) Mic-On.
    if (opts.startDeafened) {
      this.deafened = true;
      this.#audioEls.setDeafened(true);
      // Carry the pre-deafen mic state across a channel switch so un-deafen
      // in the new channel restores the mic like it would have in the old one.
      this.#micEnabledBeforeDeafen = micBeforeDeafen;
    }
    // Make sure the gateway has our state even if neither setMicEnabled nor
    // setDeafened ran (PTT mode + not deafened = both false → no setter fired,
    // but we still want to clear any stale state from a previous session).
    this.#publishSelfState();
    // Register an OS media session so mobile keeps the call audio alive while
    // backgrounded / screen-locked (paired with the unmuted <audio> path in
    // RemoteAudioElements). No-op off mobile.
    setVoiceMediaSession(this.channelName);
    // Capture a routing snapshot once the OS has settled the route (~2.5s), to
    // verify the SCO/mode result in the field. No-op off Capacitor-Android.
    // Tracked so #teardown cancels it on a fast leave/channel-switch.
    this.#audioDiagTimer = setTimeout(() => {
      this.#audioDiagTimer = null;
      void maybeSendAudioDiagnostic();
    }, 2500);
    // Mobile: hold the screen awake so auto-lock can't suspend the mic, and watch
    // for foreground returns to recover a mic the OS muted while backgrounded.
    this.#ensureWakeLock();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisible);
    }
    sounds.play('voice.self_join', { guildId: guilds.guildIdForChannel(channelId) });
  }

  /** Die native Kanalansicht zeigen (Griff in der Leiste). Ausserhalb des
   *  nativen Wegs ein No-op. */
  ansichtOeffnen(): Promise<void> {
    return this.#nativ.ansichtOeffnen();
  }

  /** Nur die Ansicht wegnehmen — der Raum bleibt. Gerufen, wenn die Web-Route
   *  den Kanal verlässt (`VoiceNativeAnsichtGriff.svelte`). */
  ansichtSchliessen(): Promise<void> {
    return this.#nativ.ansichtSchliessen();
  }

  /** Admin-Stummschaltung im Kanal an die native Ansicht (WS
   *  `voice_override`, `ready`). Ausserhalb des nativen Wegs ein No-op. */
  nativErzwungenAbgleichen(): void {
    this.#nativ.erzwungenAbgleichen();
  }

  /** Nach einem Reload einen Raum übernehmen, den die Hülle noch hält
   *  (Entwurf §5). Das Ergebnis entscheidet danach über den Resume-Eintrag
   *  (`startBeitritt.ts::resumePlan`). Ein `connect()` oder `disconnect()`
   *  während der Abfrage macht sie `ueberholt`. */
  async nativUebernehmen(resume: VoiceResume | null): Promise<StartAbgleich> {
    const gen = this.#connectGen;
    const ergebnis = await this.#nativ.uebernehmen(
      resume,
      activeServer.serverId,
      () => gen === this.#connectGen
    );
    // Wie `connect()`: ein künftiger Abbruch muss wieder abräumen dürfen.
    if (ergebnis === 'uebernehmen') this.#teardownDone = false;
    return ergebnis;
  }

  /**
   * Tear down the LiveKit room. Pass `reason: 'user'` for an *explicit*
   * leave (PhoneOff click, channel switch) — this is the only path that
   * also ends any watch party the local user is hosting in the channel.
   * Page-unload / sign-out / guild-deleted callers omit the reason so a
   * brief page refresh doesn't kill the host's party.
   */
  async disconnect(opts: { reason?: 'user' } = {}): Promise<void> {
    // Zuerst einen laufenden `connect()` entwerten — noch VOR jedem `await`
    // hier, sonst schluepft der Verbindungsaufbau zwischendurch an seinen
    // Wachposten vorbei.
    this.#abbruchGen = this.#connectGen;
    this.#connectGen++;
    // **Der native Weg hat KEINEN `#room` — und genau daran hing er fest.**
    // Der Wachposten unten („Raum stand noch gar nicht") räumt nur auf, wenn
    // der Zustand `Connecting` ist; bei `Connected` kehrte er wortlos zurück.
    // Die Hülle trennte zwar, aber die Oberfläche blieb im Kanal stehen und
    // liess sich nicht mehr verlassen (am Gerät gemeldet, 2026-10-10).
    //
    // Die Trennung selbst passiert deshalb weiter unten, NACH der
    // gemeinsamen Arbeit (Verlass-Ton, laufende Übertragungen stoppen,
    // Watch-Party beenden, Resume-Eintrag löschen) — die gilt für beide Wege
    // gleichermassen und darf nicht ein zweites Mal danebenstehen.
    const nativ = this.nativ;
    const room = this.#room;
    if (!room && !nativ) {
      // Aufgelegt, bevor der Raum ueberhaupt stand (der Token-Abruf laeuft
      // noch): der zurueckkehrende `connect()` bricht jetzt am Wachposten ab,
      // raeumt aber die schon gesetzte Oberflaeche nicht mehr auf — das tun
      // wir hier. Ohne diesen Zweig blieb der Knopf auf „Verbinden" stehen.
      if (this.state === ConnectionState.Connecting && this.channelId !== null) {
        if (opts.reason === 'user') clearVoiceResume();
        this.state = ConnectionState.Disconnected;
        this.channelId = null;
        this.channelName = null;
        this.error = null;
        voiceState.channelId = null;
        voiceState.connected = false;
      }
      return;
    }
    sounds.play('voice.self_leave', this.#soundCtx);
    // Verlassen wir den Voice-Channel, muss ein laufender HQ-Stream mit weg —
    // er ist an genau diesen Channel gebunden. Sonst pusht der Sidecar weiter
    // und der Stream taucht beim Wieder-Verbinden als „live" wieder auf.
    // No-op im Browser (keine Sidecar-Bridge) und wenn nichts läuft. ALLE
    // laufenden Slots stoppen — jeder zusätzliche Stream hängt am selben Channel.
    for (const slot of runningStreamSlots()) {
      void sidecar.stop(slot).catch(() => undefined);
    }
    if (opts.reason === 'user') {
      // Explizites Verlassen (Auflegen / Channel-Wechsel) → kein Auto-Rejoin
      // beim nächsten Reload. Transport-Trennungen (Reload/WS-Blip) lassen den
      // Resume-Eintrag bewusst stehen.
      clearVoiceResume();
      const cid = this.channelId;
      const me = currentServerUserId();
      if (cid && me) {
        // End every party the local user hosts in this channel.
        for (const party of watchPartyPresence.partiesHostedBy(cid, me)) {
          gateway.stopWatchParty(cid, party.party_id);
        }
      }
    }
    if (nativ) {
      // In der Wache: ein `connect` wartet, bis auch `#teardown` durch ist (B2).
      await this.#nativAbbau.fahren(async () => {
        try {
          await this.#nativ.verlassen();
        } finally {
          // Auch wenn die Hülle sich beschwert: die Oberfläche muss zurück.
          // Ein Nutzer, der nicht auflegen kann, ist der schlimmere Zustand.
          this.#teardown();
        }
      });
      return;
    }
    // Nur noch fuer den Typpruefer: ohne Raum UND ohne nativen Weg ist oben
    // schon zurueckgekehrt, der native Fall eben. Hier bleibt der Web-Weg.
    if (!room) return;
    try {
      await room.disconnect();
    } finally {
      this.#teardown();
    }
  }

  /** Bricht einen `connect()` ab, den ein Auflegen oder ein neuerer Aufbau
   *  entwertet hat: Geraete-Spuren zurueck, dann den Raum trennen (Begruendung
   *  der Reihenfolge in `abbruch.ts`). Hat kein neuerer `connect()` uebernommen
   *  (`channelId` leer), geben wir zusaetzlich den Android-Rufmodus frei — der
   *  wurde vor `room.connect()` gesetzt und `#teardown` kann ihn nicht
   *  zuverlaessig zurueckstellen, wenn er gerade erst gesetzt wird. */
  async #abbruch(room: Room): Promise<void> {
    // Sicherung: niemals den lebenden Raum abraeumen.
    if (this.#room === room) return;
    await raumVerwerfen(room);
    if (this.channelId === null) {
        void setVoiceActive(false);
        void tonVoice('sprachkanal', false);
    }
  }

  async setMicEnabled(on: boolean): Promise<void> {
    // iOS, nativer Weg: die Spur gehört der Hülle, nicht einem JS-Raum.
    if (this.nativ) return this.#nativ.befehle.mikrofon(on);
    const room = this.#room;
    if (!room) return;
    // Optimistic UI: micEnabled synchron vor dem await setzen, sonst blitzt
    // das Tray-Icon beim Mic-Toggle kurz rot auf (Listener sehen transient
    // connected=true + micEnabled=false). Im catch auf den alten Wert zurück.
    const prevMic = this.micEnabled;
    this.micEnabled = on;
    try {
      await room.localParticipant.setMicrophoneEnabled(on, this.#audioCaptureDefaults());
      // Derselbe Bauplan wie beim Verbinden: waehrend des `await` kann der
      // Nutzer aufgelegt haben. Dann ist dieser Raum nicht mehr der lebende,
      // und die eben erzeugte Mikrofonspur bliebe offen — zuruecknehmen statt
      // sie mit `micEnabled = true` in einem toten Raum stehen zu lassen.
      if (this.#room !== room) {
        if (on) await quelleZuruecknehmen(room, Track.Source.Microphone);
        return;
      }
      if (on) {
        await this.applyNoiseFilter();
        this.#signal.attachLocalAnalyser();
      } else {
        this.#signal.nachMikroAus();
      }
    } catch (e) {
      // Nach dem Auflegen gehoert der Zustand nicht mehr uns — weder der
      // alte Mikrofonstand noch eine Fehlermeldung.
      if (this.#room !== room) return;
      this.micEnabled = prevMic;
      this.error = e instanceof Error ? e.message : m.livekit_microphone_access_failed();
    }
    this.#refreshParticipants();
    this.#publishSelfState();
  }

  /** Hold a screen wake-lock while connected on mobile so the phone's auto-lock
   *  can't blank the screen and suspend the outgoing mic. Idempotent; mobile-only
   *  (no point forcing a desktop monitor awake during a call). */
  #ensureWakeLock(): void {
    if (!isMobile() || this.#releaseWakeLock) return;
    this.#releaseWakeLock = acquireWakeLock();
  }

  /** On return to the foreground: if the user intends mic-on but the OS muted the
   *  track while backgrounded (mobile screen-lock), re-enable it. Mobile browsers
   *  can't keep capture alive in the background — this at least recovers the mic
   *  so the user isn't silently muted after unlocking. No-op when the mic is
   *  already live, in PTT/deafen, or admin-force-muted. */
  async #recoverMicAfterForeground(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    if (!this.micEnabled || this.pttMode || this.deafened) return;
    if (this.#selfOverride().muted) return; // admin force-mute: leave as-is
    if (room.localParticipant.isMicrophoneEnabled) return; // already live, nothing to do
    await this.setMicEnabled(true);
    if (room.localParticipant.isMicrophoneEnabled) {
      toast.success(m.voice_mic_restored_after_background());
    }
  }

  /** Admin force-mute / force-deafen for the local user in the current
   *  channel. The UI disables the mic/deafen buttons on this, but the
   *  keyboard shortcuts call toggleMic/toggleDeafen directly — so the gate
   *  lives at those entry points, reading the same store the buttons do. */
  #selfOverride(): { muted: boolean; deafened: boolean } {
    const cid = this.channelId;
    const uid = currentServerUserId();
    if (!cid || !uid) return { muted: false, deafened: false };
    return {
      muted: voicePresence.isForceMuted(cid, uid),
      deafened: voicePresence.isForceDeafened(cid, uid)
    };
  }

  toggleMic(): void {
    // Deafened → the mic is held off (setDeafened muted it). Toggling here would
    // compute target=true and re-enable the mic while the user believes they're
    // silent. Refuse — un-deafen is the only path that brings the mic back.
    if (this.deafened) return;
    // Force-muted by an admin → the mic toggle is inert (button is disabled;
    // this also blocks the keyboard-shortcut path). Mirrors toggleDeafen.
    if (this.#selfOverride().muted) return;
    const target = !this.micEnabled;
    sounds.play(target ? 'voice.self_unmute' : 'voice.self_mute', this.#soundCtx);
    void this.setMicEnabled(target);
  }

  /** Enable/disable push-to-talk mode. Entering PTT mode mutes the mic. */
  async setPttMode(on: boolean): Promise<void> {
    settings.setPttMode(on);
    if (on) {
      await this.setMicEnabled(false);
    } else {
      // Respect admin force-mute: don't enable the mic if an admin has muted us.
      if (this.#selfOverride().muted) return;
      await this.setMicEnabled(true);
    }
  }

  /** Called from the PTT key handler — opens the mic while held. */
  pttPress(): void {
    if (!this.pttMode || !this.connected) return;
    if (!this.micEnabled) void this.setMicEnabled(true);
  }
  pttRelease(): void {
    if (!this.pttMode || !this.connected) return;
    if (this.micEnabled) void this.setMicEnabled(false);
  }

  setDeafened(on: boolean): void {
    if (on === this.deafened) return;
    // Discord-style: deafen also mutes the mic (no point talking if you can't
    // hear reactions), un-deafen restores the prior mic state. PTT users
    // never get auto-unmuted — their default mic state is "off until held."
    if (on) {
      this.#micEnabledBeforeDeafen = this.micEnabled;
      if (this.micEnabled) void this.setMicEnabled(false);
    } else {
      if (this.#micEnabledBeforeDeafen && !this.pttMode && !this.#selfOverride().muted) {
        void this.setMicEnabled(true);
      }
      this.#micEnabledBeforeDeafen = false;
    }
    this.deafened = on;
    // **iOS, nativer Weg: die `<audio>`-Elemente gibt es hier nicht.** Den Ton
    // der anderen spielt der native Prozess, also muss das Nicht-Mehr-Hören
    // dort geschehen (die Hülle stellt die Lautstärke jeder fremden Tonspur
    // auf 0 und beim Zurücknehmen auf ihren vorherigen Wert).
    //
    // Bis zum 2026-10-10 lief dieser Knopf auf iOS ins Leere — und das war
    // schlimmer als eine fehlende Funktion: das Zeichen kippte, die Zeile
    // darunter meldete allen anderen „taub", und gehört wurde weiter alles.
    // Die Mikrofon-Hälfte oben hat immer funktioniert (sie geht über
    // `setMicEnabled` und damit nativ), was den Fehler besonders gut
    // versteckte.
    if (this.nativ) this.#nativ.befehle.taub(on);
    else this.#audioEls.setDeafened(on);
    sounds.play(on ? 'voice.self_deafen' : 'voice.self_undeafen', this.#soundCtx);
    this.#publishSelfState();
  }
  toggleDeafen(): void {
    // Force-deafened by an admin → refuse to un-deafen until the override is
    // cleared. The deafen button is disabled in the UI; this closes the
    // keyboard-shortcut bypass (voice.toggleDeafen → here, ungated before).
    if (this.#selfOverride().deafened) return;
    this.setDeafened(!this.deafened);
  }

  /** Bughunt Runde 25: Nach dem (Re-)Connect den geseedeten Override-Zustand
   *  mit dem lokalen Mikrofon abgleichen. Ein in einer WS-Lücke erteiltes
   *  Force-Mute ging sonst für immer verloren: das live-WS-Event traf tote
   *  Sockets, der Ready-Seed disabled nur die Buttons, der Track blieb
   *  unmuted — und applyForceMute(false) des späteren Unmute early-returnte,
   *  weil #forceMuted nie true geworden war. */
  applyOverrideReconciliation(muted: boolean, deafened: boolean): void {
    if (muted && !this.#forceMuted) this.applyForceMute(true);
    if (!muted && this.#forceMuted) this.applyForceMute(false);
    if (deafened !== this.deafened) this.setDeafened(deafened);
  }

  /** React to an admin force-mute / force-unmute for the local user.
   *  Driven from the `voice_override` WS handler. Discord-style: on mute we
   *  remember the prior mic state and stop the local track; on unmute we
   *  restore it (if it was on, and the user hasn't self-muted / entered PTT /
   *  deafened meanwhile). Without the restore the server hands the publish
   *  permission back but the client never re-publishes — the user stays
   *  silent while the UI shows their mic as on. */
  applyForceMute(muted: boolean): void {
    if (muted === this.#forceMuted) return;
    this.#forceMuted = muted;
    if (muted) {
      this.#micEnabledBeforeForceMute = this.micEnabled;
      if (this.micEnabled) void this.setMicEnabled(false);
    } else {
      if (this.#micEnabledBeforeForceMute && !this.pttMode && !this.deafened) {
        void this.setMicEnabled(true);
      }
      this.#micEnabledBeforeForceMute = false;
    }
  }

  /** Call from a synchronous click handler to unblock audio playback.
   *
   *  **Beide Startversuche muessen in derselben Aufgabe wie der Klick stehen.**
   *  WebKit verwirft die Nutzeraktivierung ueber ein `await` hinweg; ein
   *  `await room.startAudio()` VOR dem eigenen Nachspielen verbrannte sie, und
   *  danach wurde jedes `<audio>.play()` wieder abgelehnt — der Knopf sah tot
   *  aus, obwohl er ausloeste (am 2026-10-09 am iPhone gemeldet). `startAudio`
   *  ist zwar `async`, setzt seine `play()`-Aufrufe aber noch synchron ab
   *  (erst danach wartet es auf `Promise.all`), also genuegt es, es ohne
   *  `await` anzustossen und erst spaeter einzusammeln.
   *
   *  Auf iOS-WebKit entscheidet ueber `audioBlocked` das Ergebnis UNSERER Elemente,
   *  nicht `room.canPlaybackAudio`: dort sind sie der hoerbare Weg, waehrend
   *  LiveKits Zaehlung nur die per `track.attach()` angehaengten SDK-Elemente
   *  umfasst — und die bleiben leer, wir legen eigene an. Ohne diese
   *  Unterscheidung meldete `canPlaybackAudio` Erfolg, weil LiveKit nur sein
   *  stummes iOS-Hilfselement abspielen musste. */
  async unblockAudio(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    // Desktop und Android: unverändert wie vor der iOS-Arbeit. iOS-WebKit:
    // beide Startversuche noch in der Geste, Begründung im Doc-Kommentar oben.
    if (!isIosWebKit()) {
      try {
        await room.startAudio();
      } catch {
        // Ein Fehler heißt: weiterhin gesperrt. Der Zustand steht gleich unten
        // in `room.canPlaybackAudio`.
      }
      void this.#audioEls.replayAll();
      this.audioBlocked = !room.canPlaybackAudio;
      return;
    }
    // Reihenfolge ist wesentlich: beides noch in der Geste absetzen.
    const livekit = room.startAudio().catch(() => undefined);
    const eigene = this.#audioEls.replayAll();
    await livekit;
    const eigeneSpielen = await eigene;
    // Überholt, während die Versuche liefen: der Zustand gehört schon einem
    // anderen Raum (oder keinem mehr).
    if (room !== this.#room) return;
    this.audioBlocked = !eigeneSpielen;
    if (eigeneSpielen) this.audioBlockGrund = '';
  }

  async setScreenShare(on: boolean): Promise<void> {
    const room = this.#room;
    if (!room) return;
    try {
      if (on) {
        const { s, resolution, aufloesung, publishOptions } = bildschirmPlan(this.channelId);
        // Win11 + Chrome/Edge 141+: bypass LiveKit's setScreenShareEnabled to
        // pass `windowAudio:"window"` (not exposed in ScreenShareCaptureOptions
        // and dropped by LiveKit's constraint whitelist). On other platforms
        // / older Chromium the bypass would silently strip audio entirely
        // (systemAudio:"exclude" with no per-window-audio fallback) — keep the
        // regular LiveKit path there.
        if (await canUseWindowAudioCapture()) {
          const stream = await acquireWindowAudioStream({ resolution: aufloesung });
          // Mirror what LiveKit does internally for ScreenShareCaptureOptions
          // — contentHint goes on the track, not in getDisplayMedia constraints.
          const v = stream.getVideoTracks()[0];
          if (v) v.contentHint = s.contentHint;
          await this.#fensterTon.veroeffentlichen(room.localParticipant, stream, publishOptions, () =>
            void this.setScreenShare(false)
          );
          // Aufgelegt, waehrend die Auswahl offen war: der Raum ist weg, die
          // Aufnahme laeuft. Zuruecknehmen, sonst zeigt das System weiter
          // „Sie teilen Ihren Bildschirm".
          if (this.#room !== room) {
            await this.#fensterTon.zurueckziehen(room.localParticipant);
            return;
          }
          this.isScreenSharing = true;
        } else {
          const captureOptions: ScreenShareCaptureOptions = {
            audio: true,
            contentHint: s.contentHint
          };
          if (resolution !== 'native') captureOptions.resolution = aufloesung;
          await room.localParticipant.setScreenShareEnabled(
            true,
            captureOptions,
            publishOptions
          );
          // Gleiche Lage wie im Bypass-Zweig: aufgelegt, waehrend die Auswahl
          // offen war.
          if (this.#room !== room) {
            await quelleZuruecknehmen(room, Track.Source.ScreenShare);
            await quelleZuruecknehmen(room, Track.Source.ScreenShareAudio);
            return;
          }
          this.isScreenSharing = true;
        }
      } else {
        if (this.#fensterTon.aktiv) {
          await this.#fensterTon.zurueckziehen(room.localParticipant);
        } else {
          await room.localParticipant.setScreenShareEnabled(false);
        }
        this.isScreenSharing = false;
      }
    } catch (e) {
      this.isScreenSharing = false;
      bildschirmFehlerMelden(e);
    }
  }

  toggleScreenShare(): void {
    void this.setScreenShare(!this.isScreenSharing);
  }

  /** Publish/unpublish the local camera track — der Web-Weg samt Auflösung
   *  steht in `eigeneKamera.ts::kameraSetzen`. */
  async setCamera(on: boolean): Promise<void> {
    // iOS, nativer Weg: die Kamera gehört der Hülle. Das Bild erscheint nicht
    // hier, sondern in der nativen Kanalansicht — `localCameraTrack` bleibt
    // deshalb leer (Begründung in `nativerRaum.svelte.ts`).
    if (this.nativ) return this.#nativ.befehle.kamera(on);
    const room = this.#room;
    await kameraSetzen(room, on, this, () => this.#room === room);
  }

  toggleCamera(): void {
    void this.setCamera(!this.isCameraOn);
  }

  /** Switch between front ('user') and back ('environment') camera. Restarts
   *  the existing publication's track in place so the swap is seamless and
   *  remote subscribers keep the same track. No-op unless the cam is live. */
  async flipCamera(): Promise<void> {
    // iOS, nativer Weg: `null` als `localCameraTrack` ist dort kein „keine
    // Kamera", der Wächter in `kameraWechseln` griffe also falsch.
    if (this.nativ) return this.#nativ.befehle.kameraWechseln();
    await kameraWechseln(this);
  }

  /** Populate the device pickers without being in a channel (settings panel /
   *  mic test). Needs a prior getUserMedia grant for labels to show. */
  async refreshDevices(): Promise<void> {
    await this.#devices.refresh(this.#room);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    await this.#devices.setInput(this.#room, deviceId);
    this.#signal.nachGeraetewechsel();
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.#devices.setOutput(this.#room, deviceId);
  }

  /** Live-apply a per-user gain change to any currently-subscribed track for
   *  that user. Persisting happens in `settings.setUserVolume` — call both. */
  setUserVolume(userId: string, volume: number): void {
    // iOS, nativer Weg: die `<audio>`-Elemente gibt es dort nicht — die
    // Lautstärke stellt die Hülle (Bughunt 2026-10-11, M4). Immer die ganze
    // Tabelle; der Aufrufer hat die Einstellung schon gespeichert.
    if (this.nativ) {
      this.#nativ.befehle.lautstaerken(
        { ...$state.snapshot(settings.voice.userVolumes), [userId]: volume },
        settings.voice.outputVolume
      );
      return;
    }
    this.#audioEls.setUserVolume(userId, volume);
  }

  /** Live-toggle the playback peak limiter on all subscribed tracks.
   *  Persisting happens in `settings.setLimiterEnabled` — call both. */
  setLimiterEnabled(on: boolean): void {
    this.#audioEls.setLimiterEnabled(on);
    // iOS, nativer Weg: der Begrenzer sitzt in der Hülle; liest die schon
    // gespeicherte Einstellung (`Wiedergabebegrenzer.swift`).
    this.#nativ.hoeren();
  }

  /** Live-apply the master playback volume (0..2) to all subscribed tracks.
   *  Persisting happens in `settings.setOutputVolume` — call both. */
  setOutputVolume(v: number): void {
    // Wie `setUserVolume`. `v` statt der Einstellung: der Regler ruft das
    // hier VOR dem Speichern (`OutputVolumeControl.svelte`).
    if (this.nativ) {
      this.#nativ.befehle.lautstaerken($state.snapshot(settings.voice.userVolumes), v);
      return;
    }
    this.#audioEls.setMasterVolume(v);
  }

  /** Live-switch the spatial-audio mode on all subscribed tracks (desktop only).
   *  Persisting happens in `settings.setSpatialMode` — call both. */
  setSpatialMode(mode: SpatialMode): void {
    void this.#audioEls.setSpatialMode(mode);
  }

  /** Set the spatial frontal-fan layout (total arc in °, shared distance in m). */
  setSpatialLayout(spreadDeg: number, distanceM: number): void {
    this.#audioEls.setSpatialLayout(spreadDeg, distanceM);
  }

  /** (Re)apply the send-side processor — s. `EigenesSignal.applyNoiseFilter`.
   *  Gerufen auch von aussen (Einstellungen, Gerätewechsel, iOS-Wegwechsel). */
  applyNoiseFilter(): Promise<void> {
    return this.#signal.applyNoiseFilter();
  }

  /** Live-update the post-RNNoise gate threshold (dB); persisting is the
   *  caller's job. */
  setNoiseGateThresholdDb(openDb: number): void {
    this.#signal.setNoiseGateThresholdDb(openDb);
  }

  /** Live-update the sender-side makeup gain; persisting is the caller's job. */
  setInputMakeupGain(v: number): void {
    this.#signal.setInputMakeupGain(v);
  }

  /** Toggle "hear yourself" while in a channel + remember the output sink. */
  setSelfMonitor(on: boolean, outputId: string): Promise<void> {
    return this.#signal.setSelfMonitor(on, outputId);
  }

  // --- internals -----------------------------------------------------

  #roomOptions(): RoomOptions {
    return {
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: this.#audioCaptureDefaults(),
      // Beim Connect eingefroren: spätere Setting-Änderungen (Bitrate/Stereo)
      // greifen erst beim nächsten Connect.
      publishDefaults: this.#audioPublishDefaults()
    };
  }

  /** Opus-Publish-Defaults (Encoder-Seite): Bitrate, Stereo, DTX, RED.
   *  DTX ist fest an — spart Bandbreite in Sprechpausen. Das setzt den
   *  Opus-DTX-Fix voraus (webrtc #42233214, ab Chromium 150 / Electron 43),
   *  sonst knackst der Wiedereinstieg nach Stille. */
  #audioPublishDefaults(): Pick<
    TrackPublishOptions,
    'audioPreset' | 'forceStereo' | 'dtx' | 'red'
  > {
    const a = settings.audio;
    const customProcessor = a.noiseSuppression !== 'off';
    // Die Sprach-Bitrate BESTIMMT der Server (Guild-Override ?? Instanzwert) —
    // es gibt bewusst keinen Nutzer-Regler mehr: niemand stellt Qualität
    // freiwillig niedriger als vorgesehen (Entscheidung 2026-07-17).
    const voiceKbps = effectiveVoiceBitrateMaxKbps(this.channelId);
    return {
      audioPreset: { maxBitrate: voiceKbps * 1000 },
      forceStereo: a.stereo && !customProcessor,
      dtx: true,
      red: true
    };
  }

  #audioCaptureDefaults(): AudioCaptureOptions {
    const a = settings.audio;
    const customProcessor = a.noiseSuppression !== 'off';
    const opts: AudioCaptureOptions = {
      autoGainControl: false,
      echoCancellation: a.echoCancellation,
      // RNNoise+Gate handles noise — no browser-side NS layered on top.
      noiseSuppression: false,
      // Custom processor is mono — stereo capture yields nothing.
      channelCount: a.stereo && !customProcessor ? 2 : 1
    };
    if (a.inputDeviceId) opts.deviceId = a.inputDeviceId;
    return opts;
  }

  /** Debounced wrapper: coalesces rapid bursts of LiveKit events into a single
   *  rebuild. Multiple calls within the debounce window resolve to one
   *  `#refreshParticipants` invocation. */
  #scheduleRefresh(): void {
    if (this.#refreshTimer !== null) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      this.#refreshParticipants();
    }, PARTICIPANT_REFRESH_DEBOUNCE_MS);
  }

  #refreshParticipants(): void {
    const room = this.#room;
    this.participants = room
      ? teilnehmerListe(room, this.localSpeaking, (id) => this.#remoteSpeaking.isSpeaking(id))
      : [];
  }

  /** Playback-Setter erneut anwenden (idempotent) — nach dem Room-Bau und
   *  nochmal nach dem connect-await, falls sich die Settings inzwischen
   *  geändert haben. */
  #applyPlaybackSettings(): void {
    this.#audioEls.deafened = this.deafened;
    this.#audioEls.outputDeviceId = this.#devices.selectedOutputId;
    this.#audioEls.setUserVolumes(settings.voice.userVolumes);
    this.#audioEls.setMasterVolume(settings.voice.outputVolume);
    this.#audioEls.setLimiterEnabled(settings.audio.limiterEnabled);
    void this.#audioEls.setSpatialMode(settings.audio.spatialMode);
  }

  #onRemoteSpeakingChange(identity: string, speaking: boolean): void {
    const idx = this.participants.findIndex((p) => p.identity === identity);
    if (idx < 0 || this.participants[idx].isSpeaking === speaking) return;
    // Svelte 5 $state deep-proxies the array; mutating the element in place is
    // reactive and avoids allocating a new array + object on every speaking transition.
    this.participants[idx].isSpeaking = speaking;
  }

  /** Die eigene Zeile der Teilnehmerliste dem Sprech-Stand nachziehen —
   *  `EigenesSignal` meldet nur den Wechsel. */
  #eigenesSprechenSpiegeln(s: boolean): void {
    const idx = this.participants.findIndex((p) => p.isLocal);
    if (idx >= 0 && this.participants[idx].isSpeaking !== s) {
      // Same deep-proxy mutation as above — no full array copy needed.
      this.participants[idx].isSpeaking = s;
    }
  }

  #teardown(): void {
    if (this.#teardownDone) return;
    this.#teardownDone = true;
    // Auch ein Abbau von aussen (Kick, Netzverlust, LiveKit meldet getrennt)
    // entwertet einen laufenden `connect()` — sonst schriebe der beim
    // Zurueckkehren den gerade abgeraeumten Zustand wieder hin.
    this.#connectGen++;
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    if (this.#audioDiagTimer !== null) {
      clearTimeout(this.#audioDiagTimer);
      this.#audioDiagTimer = null;
    }
    this.#signal.abbauen();
    this.#remoteSpeaking.clear();
    this.#audioEls.destroy();
    clearVoiceMediaSession();
    // Android: release MODE_IN_COMMUNICATION + the comm device so the phone
    // leaves call-mode after we hang up. No-op off Capacitor-Android.
    void setVoiceActive(false);
    void tonVoice('sprachkanal', false);
    // Wake-Lock freigeben, BEVOR die Referenz fällt — sonst bleibt das Display
    // für die restliche Sitzung an (der Griff ist dann nicht mehr erreichbar).
    this.#releaseWakeLock?.();
    this.#releaseWakeLock = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisible);
    }
    this.#room = null;
    this.#signal.clearProcessorHandles();
    this.state = ConnectionState.Disconnected;
    if (this.channelId) {
      const myUserId = currentServerUserId();
      if (myUserId) voicePresence.removeUser(this.channelId, myUserId);
      // Tell the gateway we're no longer in a voice channel so it drops our
      // mute/deafen state and republishes the channel snapshot to peers.
      try {
        gateway.sendVoiceSelfState(null, false, false);
      } catch {
        // The gateway connection might be down — state will time-out via the
        // server-side TTL.
      }
    }
    this.channelId = null;
    this.channelName = null;
    this.participants = [];
    this.micEnabled = false;
    this.deafened = false;
    this.#micEnabledBeforeDeafen = false;
    this.#micEnabledBeforeForceMute = false;
    this.#forceMuted = false;
    this.isScreenSharing = false;
    this.isCameraOn = false;
    this.localCameraTrack = null;
    this.cameraFacing = 'user';
    // Der native Spiegel: Hörer ab, Merker zurück. Die Hülle nimmt die
    // Ansicht beim Verlassen selbst weg; ohne das hier bliebe der Griff
    // „zurück in den Kanal" stehen, obwohl es keinen Kanal mehr gibt.
    this.#nativ.zuruecksetzen();
    this.#cameras.clear();
    this.#fensterTon.nachAbbauStoppen();
    this.#screenShare.clear();
    this.audioBlocked = false;
    // Der Grund gehört zum abgebauten Raum — sonst stünde er beim nächsten
    // Beitritt unter einer neuen Sperre, die einen anderen hat.
    this.audioBlockGrund = '';
    voiceState.channelId = null;
    voiceState.connected = false;
  }

  /** Push the local mute/deafen state to the chat-gateway so peers see it.
   * No-op when we are not currently connected to a voice channel — the
   * gateway only accepts state for a valid voice channel id. */
  /** Persist enough to auto-rejoin this channel after a reload (voice-resume).
   *  Mirrors the chosen mute/deafen (`#wahl`) so the restored session matches. No-op
   *  when not in a channel. */
  #saveResume(): void {
    if (!this.channelId) return;
    const wahl = this.#wahl();
    saveVoiceResume({
      serverId: activeServer.serverId,
      channelId: this.channelId,
      channelName: this.channelName ?? '',
      muted: !wahl.mikro,
      deafened: wahl.taub,
      micBeforeDeafen: this.#micEnabledBeforeDeafen,
    });
  }

  /** Was der Nutzer für Mikrofon und Mithören GEWÄHLT hat — während einer
   *  Anruf-Pause nicht dasselbe wie der wirksame Stand (B3). */
  #wahl(): NutzerWahl {
    return this.#nativ.pausenWunsch ?? { mikro: this.micEnabled, taub: this.deafened };
  }

  #publishSelfState(): void {
    if (!this.channelId) return;
    // Keep the reload-resume snapshot in sync with every mute/deafen change.
    this.#saveResume();
    try {
      gateway.sendVoiceSelfState(this.channelId, !this.micEnabled, this.deafened);
    } catch {
      // Best effort — drop the update if the WS is not open. The next state
      // change (or a manual re-emit on reconnect) will catch up.
    }
  }

  /** Re-emit the local mute/deafen state. Called after a WS reconnect — the
   * gateway clears ``voice:user_state:<uid>`` when our last socket goes away
   * (token-expiry close + reconnect race), so without this our mute/deafen
   * icons disappear for every other client until we toggle again. */
  resyncSelfState(): void {
    this.#publishSelfState();
  }
}

export const voice = new VoiceRoom();

// **Wegwechsel ändern, WER filtert** — und das kommt von keiner Nutzeraktion:
// es genügt, die AirPods einzusetzen. Die Hülle richtet die Session dann neu
// ein (am Lautsprecher mit Apples Sprachverarbeitung, mit Kopfhörern im Ohr
// auf der Hochqualitäts-Route), und der eigene Sendefilter muss neu
// entscheiden. Ohne diesen Haken liefe danach zweimal gefiltert oder gar
// nicht.
//
// Einmal je Fenster, ohne Abriss: der Rückruf prüft selbst, ob ein Raum offen
// ist (`applyNoiseFilter` kehrt ohne Raum sofort zurück), und ausserhalb der
// iOS-Hülle feuert er nie.
tonSystemFilterBeobachten(() => void voice.applyNoiseFilter());

// ShortcutHost feuert die globalen Voice-Shortcuts über die schlanke Registry
// in state.svelte.ts, damit das Root-Layout dieses Modul (und mit ihm
// livekit-client) nicht mehr laden muss.
registerVoiceActions(voice);
