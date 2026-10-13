/**
 * Der Sprachraum eines Gastes — eine eigene, kleine Fassung.
 *
 * **Warum nicht der bestehende `voice`-Store:** der hängt an Konto, Gateway,
 * Einstellungs-Speicher, Rauschfilter, Fernsteuerung, Watch-Party und einem
 * Dutzend Stores, die es auf der Gastseite nicht gibt. Ein Gast-Zweig durch
 * all das hindurch wäre teurer und zerbrechlicher als diese eine Datei, die
 * nur kann, was ein Gast darf: sprechen, Kamera, zuhören, zusehen.
 *
 * Was hier bewusst FEHLT: Bildschirm teilen (ein Gast darf es nicht, das
 * LiveKit-Token lässt die Quelle gar nicht zu), Datenkanal (trägt in Pulse
 * Fernsteuer- und Zeigerdaten), Wiederverbinden über Tage, Geräteumschaltung
 * im laufenden Betrieb.
 */

import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client';
import { createSendProcessor } from '$lib/voice/noiseFilter';
import { NOISE_GATE_DB_DEFAULT } from '$lib/settings-registry/sections/audio';
import { startAudioAbbruchfest } from '$lib/audio/abspielen';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { istGastKennung } from '$lib/stores/voicePresence.svelte';
import { gastBeitritt, gastVoiceToken, type GastBeitritt, type GastVoiceToken } from './api';
import { GastTon } from './gastTon';

type GastVideo = {
  /** LiveKit-Identität des Sendenden (`user-<id>` oder `gast-<id>`). */
  identity: string;
  name: string;
  quelle: 'camera' | 'screen';
  /** ``Track`` statt ``RemoteTrack``: eine Veröffentlichung kann auch die
   *  eigene sein. Angezeigt werden hier zwar nur fremde (die eigene Kamera
   *  malt die Kachel selbst), aber der Typ der Sammlung kennt den
   *  Unterschied nicht. */
  track: Track;
};

export type GastTeilnehmer = {
  identity: string;
  name: string;
  istGast: boolean;
  spricht: boolean;
  stumm: boolean;
};

type GastPhase = 'vorraum' | 'verbinde' | 'drin' | 'weg';

class GastRaum {
  phase = $state<GastPhase>('vorraum');
  fehler = $state<string | null>(null);
  teilnehmer = $state<GastTeilnehmer[]>([]);
  videos = $state<GastVideo[]>([]);
  mikroStumm = $state(false);
  kameraAn = $state(false);
  beitritt = $state<GastBeitritt | null>(null);
  /** Kamera-Kacheln, die der Gast geöffnet hat (LiveKit-Identities). Wie in
   *  der App: das CAM-Abzeichen an der Teilnehmer-Kachel öffnet die Kachel,
   *  nicht jedes Kamerabild läuft von selbst. */
  kamerasImBlick = $state<string[]>([]);

  /** Eine Kamera-Kachel auf-/zuklappen. */
  kameraImBlickUmschalten(identity: string): void {
    this.kamerasImBlick = this.kamerasImBlick.includes(identity)
      ? this.kamerasImBlick.filter((i) => i !== identity)
      : [...this.kamerasImBlick, identity];
  }

  #room: Room | null = null;
  /** Der eingehende Ton (Elemente, Web-Audio-Züge, Kontext) — s. `gastTon.ts`. */
  #ton = new GastTon();
  /** Das Mikrofon-Track-Objekt, an dem der Rauschfilter hängt (für den Abbau). */
  #mikroTrack: LocalAudioTrack | null = null;
  /** Generationen-Zähler gegen das Destroy/Mount-Race: ein nachlaufender
   *  ``verlassen``-Abschluss einer ALTEN Generation darf ``phase='weg'``
   *  nicht mehr in eine frisch zurückgesetzte Seite schreiben (der Gast sah
   *  sonst die Endseite ohne jeden Wiederkehr-Weg). */
  #generation = 0;
  /** Der eigene Kamera-Track (lokal, ``videos`` trägt ihn bewusst nicht).
   *  Ohne diese Referenz wäre „Kamera an“ für den Gast ein toter Knopf —
   *  er sähe sich selbst nirgends. */
  eigenesVideo = $state<Track | null>(null);
  /** Wird gerufen, wenn die Verbindung endet — egal ob durch Auflegen,
   *  Rauswurf oder Ticket-Ablauf. Die Seite hängt daran das Einstellen der
   *  Stream-Abfrage: ein rausgeworfener Gast fragte sonst weiter im
   *  Fünf-Sekunden-Takt nach und bekäme im Takt ein 403. */
  #beimEnde: (() => void) | null = null;

  beimEnde(rueckruf: (() => void) | null): void {
    this.#beimEnde = rueckruf;
  }

  get ticket(): string | null {
    return this.beitritt?.ticket ?? null;
  }

  /** Den Zustand für einen frischen Besuch zurücksetzen.
   *
   * Der Raum ist ein Modul-Singleton und überlebt damit den Wechsel der
   * Seite. Ohne dieses Zurücksetzen sähe ein Gast, der die Besprechung
   * verlassen hat und den Link erneut öffnet, weiterhin die Endseite —
   * der Zustand ``weg`` bliebe stehen, obwohl er gerade neu ankommt.
   * Dasselbe gilt für eine stehengebliebene Fehlermeldung.
   */
  zuruecksetzen(): void {
    this.#generation += 1; // in-flight ``verlassen``-Abschlüsse entwerten
    if (this.#room) return; // eine laufende Verbindung nicht wegräumen
    this.phase = 'vorraum';
    this.fehler = null;
    this.beitritt = null;
    this.teilnehmer = [];
    this.videos = [];
    this.mikroStumm = false;
    this.kameraAn = false;
    this.kamerasImBlick = [];
    this.eigenesVideo = null;
  }

  async beitreten(code: string, name: string): Promise<void> {
    this.phase = 'verbinde';
    this.fehler = null;
    try {
      const b = await gastBeitritt(code, name);
      this.beitritt = b;
      let tok: GastVoiceToken;
      try {
        tok = await gastVoiceToken(b.ticket, b.channel_id);
      } catch (e) {
        // Entscheidung 3.1 (2026-09-21): der Token-Endpunkt antwortet
        // abgelaufen jetzt mit 403 (wie der WHEP-Pfad) — hier als
        // eigener Fehler-Schlüssel „Besprechung vorbei" statt des
        // missverständlichen „entfernt".
        if ((e as { status?: number }).status === 403) {
          this.beitritt = null;
          throw Object.assign(new Error('besprechung_vorbei'), { gastSchluessel: 'besprechung_vorbei' });
        }
        // Halb-Beitritt: das Ticket existiert serverseitig, aber der Gast
        // kann es nie benutzen (kein Voice-Token). Ohne dieses Aufräumen
        // bliebe es als „Belegung“ bis zum Ablauf liegen und eine Wiederholung
        // stieß eher an das Volllimit.
        this.beitritt = null;
        throw e;
      }
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: this.#aufnahmeVorgaben()
      });
      // Vor room.connect() (dort wird das Ereignis verdrahtet), s. Helfer.
      startAudioAbbruchfest(room);
      this.#room = room;
      this.#verdrahten(room);
      await room.connect(tok.ws_url, tok.token);
      await room.localParticipant.setMicrophoneEnabled(true, this.#aufnahmeVorgaben());
      await this.#rauschfilterInstallieren(room);
      this.phase = 'drin';
      this.#auffrischen();
    } catch (e) {
      // Der Beitritt ist der einzige Punkt, an dem der Gast überhaupt etwas
      // tun kann. Scheitert er, muss der Grund stehenbleiben — zurück in den
      // Vorraum, mit Text.
      this.fehler = (e as Error).message || 'fehler';
      this.phase = 'vorraum';
      await this.#abbauen();
    }
  }

  async verlassen(): Promise<void> {
    const generation = this.#generation;
    await this.#abbauen();
    if (generation !== this.#generation) {
      // Ein ``zuruecksetzen`` (frischer Seitenaufruf) ist dazwischen gewesen —
      // die alte Generation schreibt ``weg`` nicht mehr hinein. ABER: jenes
      // Zuruecksetzen lief am ``#room``-Guard leer, weil der Teardown noch
      // lief — es wird JETZT nachgeholt, sonst bliebe der Gast in einer
      // leeren 'drin'-Ansicht ohne Weg zurück.
      this.zuruecksetzen();
      return;
    }
    this.phase = 'weg';
    this.#beimEnde?.();
  }

  async mikroUmschalten(): Promise<void> {
    const lp = this.#room?.localParticipant;
    if (!lp) return;
    const an = this.mikroStumm; // stumm → jetzt einschalten
    try {
      await lp.setMicrophoneEnabled(an);
      this.mikroStumm = !an;
    } catch {
      // Gerät weggezogen / OS-Berechtigung entzogen: der Knopf darf nicht
      // still scheitern — der Gast denkt, es sei „kaputt“.
      toast.error(m.gast_geraet_fehler());
    }
  }

  async kameraUmschalten(): Promise<void> {
    const lp = this.#room?.localParticipant;
    if (!lp) return;
    const neu = !this.kameraAn;
    try {
      await lp.setCameraEnabled(neu);
      this.kameraAn = neu;
    } catch {
      toast.error(m.gast_geraet_fehler());
    }
  }

  async #abbauen(): Promise<void> {
    this.kamerasImBlick = [];
    this.eigenesVideo = null;
    const mikro = this.#mikroTrack;
    this.#mikroTrack = null;
    if (mikro) {
      try {
        await mikro.stopProcessor();
      } catch {
        // Kein Prozessor installiert (Rauschfilter scheiterte beim Beitritt) —
        // dann gibt es beim Abbau auch nichts zu stoppen.
      }
    }
    this.#ton.alleLoesen();
    this.videos = [];
    this.teilnehmer = [];
    const room = this.#room;
    this.#room = null;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // Beim Verlassen ist ein fehlgeschlagener Abbau folgenlos: die
        // Verbindung stirbt so oder so, und der Gast sieht schon die Endseite.
      }
    }
  }

  /** Mikrofon-Aufnahme wie bei den Mitgliedern: Browser-Rauschunterdrückung
   *  AUS (die legt sich mit RNNoise in die Quere), Echo-Schutz an, kein AGC. */
  #aufnahmeVorgaben(): AudioCaptureOptions {
    return {
      autoGainControl: false,
      echoCancellation: true,
      noiseSuppression: false,
      channelCount: 1
    };
  }

  /** Denselben Send-Klang wie die Mitglieder: RNNoise + Rauschtor auf dem
   *  Mikrofon-Track installieren. member default (``noiseSuppression:
   *  'rnnoise_gated'``, Tor bei -45 dB). Scheitert der Prozessor (WASM
   *  nicht geladen, Track schon weg), fällt die Aufnahme auf die
   *  Browser-Unterdrückung zurück — roh senden wäre schlechter als halb gut.
   */
  async #rauschfilterInstallieren(room: Room): Promise<void> {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.audioTrack;
    if (!track) return;
    try {
      const handle = createSendProcessor('rnnoise_gated', NOISE_GATE_DB_DEFAULT, 1);
      await track.setProcessor(handle.processor);
      this.#mikroTrack = track;
    } catch {
      try {
        await room.localParticipant.setMicrophoneEnabled(true, {
          noiseSuppression: true
        });
      } catch {
        // Die Verbindung bleibt trotzdem bestehen — nur eben ungefiltert.
      }
    }
  }

  #verdrahten(room: Room): void {
    const aktiv = (): boolean => this.#room === room;
    room
      .on(RoomEvent.ParticipantConnected, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ParticipantDisconnected, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ActiveSpeakersChanged, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.TrackMuted, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.TrackUnmuted, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
        if (!aktiv()) return;
        if (s === ConnectionState.Disconnected) {
          // Der Server hat die Verbindung beendet — bei einem Gast heisst das
          // fast immer: rausgeworfen oder Ticket abgelaufen. Beides ist
          // endgültig, es gibt nichts, worauf man warten könnte.
          void this.#abbauen();
          this.phase = 'weg';
          this.#beimEnde?.();
        }
      })
      .on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
          if (!aktiv()) return;
          if (track.kind === Track.Kind.Audio) {
            this.#ton.anhaengen(track as RemoteAudioTrack);
          }
          this.#auffrischen();
        }
      )
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        // Erstveröffentlichung feuert NUR dieses Ereignis (kein TrackSub-
        // scribed — das gibt es nur für Remote-Tracks). Ohne diesen Zweig
        // bliebe ``eigenesVideo`` beim ersten „Kamera an“ null, bis ein
        // beliebiges anderes Ereignis eine Auffrischung auslöst.
        if (!aktiv()) return;
        if (pub.source === Track.Source.Camera) {
          this.eigenesVideo = pub.track ?? null;
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (!aktiv()) return;
        this.#ton.loesen(track);
        this.#auffrischen();
      });
  }

  /** Teilnehmer- und Videoliste aus dem Raum neu bauen.
   *
   * Vollständiger Neuaufbau statt gepflegter Teillisten: die Menge ist bei
   * einer Besprechung klein, und ein Zustand, der nur aus Ereignissen wächst,
   * driftet bei jedem verpassten Ereignis. */
  #auffrischen(): void {
    const room = this.#room;
    if (!room) return;
    const sprecher = new Set(room.activeSpeakers.map((p) => p.identity));
    const liste: GastTeilnehmer[] = [];
    const videos: GastVideo[] = [];
    // Der eigene Kamera-Track wird je Durchlauf neu bestimmt — ausgeschaltete
    // Kamera darf keine stale Referenz hinterlassen.
    this.eigenesVideo = null;
    const alle = [room.localParticipant, ...room.remoteParticipants.values()];
    for (const p of alle) {
      liste.push({
        identity: p.identity,
        name: p.name?.trim() || p.identity,
        istGast: istGastKennung(p.identity),
        spricht: sprecher.has(p.identity),
        stumm: !p.isMicrophoneEnabled
      });
      for (const pub of p.trackPublications.values()) {
        const t = pub.track;
        if (!t || t.kind !== Track.Kind.Video) continue;
        if (p === room.localParticipant) {
          // Die eigene Kamera bewusst NICHT in ``videos`` — aber referenziert:
          // die Ansicht zeigt sie im eigenen Teilnehmer-Knopf, sonst wäre
          // „Kamera an“ nicht prüfbar.
          this.eigenesVideo = pub.source === Track.Source.Camera ? t : this.eigenesVideo;
          continue;
        }
        videos.push({
          identity: p.identity,
          name: p.name?.trim() || p.identity,
          quelle: pub.source === Track.Source.ScreenShare ? 'screen' : 'camera',
          track: t
        });
      }
    }
    this.teilnehmer = liste;
    this.videos = videos;
  }
}

export const gastRaum = new GastRaum();
