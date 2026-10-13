/**
 * Der eingehende Ton eines Gastes — aus `gastRaum.svelte.ts` herausgelöst, weil
 * er sich getrennt prüfen lässt (kein Raum, kein Beitritt nötig: ein
 * `RemoteAudioTrack` und ein Aufruf genügen).
 *
 * Desktop: ein stummer `<audio>`-Anker hält den Decoder am Laufen, hörbar ist
 * der Web-Audio-Zug mit dem 4×-Make-up — dieselbe Hauslautstärke, die
 * Mitglieder über `RemoteAudioElements` bekommen. Der direkte Weg (Element bei
 * Volume 1) ließ den Gast die Besprechung wie halblaut erleben. Mobil bleibt es
 * beim Element: `volume` geht dort nicht über 1 hinaus, dafür spielt es weiter,
 * wenn der Bildschirm sperrt.
 *
 * **Der Desktop-Anker ist ein eigenes Element, kein `track.attach()`** (s.
 * `audio/stummerAnker.ts`): LiveKits `startAudio()` schaltet jedes angehängte
 * Element wieder laut — und das läuft, sobald das eigene Mikrofon des Gastes
 * steht, also nach den Tönen aller, die schon da waren. Dann spielten Element
 * und 4×-Zug denselben Ton. Mobil ist das Element der hörbare Weg und gehört
 * deshalb LiveKit.
 */

import { Track, type RemoteAudioTrack, type RemoteTrack } from 'livekit-client';
import { isMobile } from '$lib/platform/runtime';
import { ankerBefestigen, ankerLoesen } from '$lib/audio/stummerAnker';
import { kontextFortsetzen } from '$lib/audio/kontextFortsetzen';

/** Eingehender Ton wird auf dem Desktop mit diesem Faktor verstärkt — dieselbe
 *  Hauslautstärke wie in der Mitglieder-Oberfläche
 *  (``RemoteAudioElements.DEFAULT_MAKEUP_GAIN``). Der Wert ist hier kopiert,
 *  nicht importiert: das Modul schleift räumlichen Klang, Kompressor und
 *  Resonanz-Loader mit, alles Dinge, die eine Gastseite nicht braucht. Ohne
 *  die 4× hört der Gast alle nur „ganz leise" — Mitglieder hören sich
 *  gegenseitig laut, weil ihre Wiedergabe durch denselben Gain läuft. */
const TON_MAKEUP = 4.0;

export class GastTon {
  /** Die eingehängten Ton-Elemente: mobil die hörbaren, per ``track.attach()``
   *  angehängten (gelöst über ``track.detach()``, das seine Elemente selbst
   *  zurückgibt), auf dem Desktop die stummen Anker (gelöst über ``#tonLoesen``).
   *  Gebraucht wird die Sammlung beim Abbau. Eine Menge, keine Karte: vorher war
   *  es eine Karte, deren Schlüssel beim Setzen und beim Löschen VERSCHIEDEN
   *  gebildet wurden (Rückfall auf die Identität gegen Rückfall auf den leeren
   *  Text) — ein Eintrag, den niemand mehr findet. */
  #audioEls = new Set<HTMLAudioElement>();
  /** Web-Audio-Zug je Ton-Track (Desktop): Quelle → Gain → Ausgabe, dazu der
   *  stumme Anker, der den Decoder am Laufen hält. Schlüssel ist die
   *  Track-SID; mobil gibt es den Zug nicht, dort ist das ``<audio>``-Element
   *  selbst der hörbare Weg. */
  #tonZuege = new Map<
    string,
    { quelle: MediaStreamAudioSourceNode; zug: GainNode; anker: HTMLAudioElement }
  >();
  /** Der AudioContext der Ton-Züge — einer für alle, beim Abbau geschlossen. */
  #tonCtx: AudioContext | null = null;
  /** Mobil? Als Funktion, weil sich die Frage erst beim Anhängen stellt (und
   *  ein Test beide Zweige fahren will). */
  #mobil: () => boolean;

  constructor(mobil: () => boolean = isMobile) {
    this.#mobil = mobil;
  }

  /** Einen eingehenden Ton-Track hörbar machen. */
  anhaengen(track: RemoteAudioTrack): void {
    if (this.#mobil()) {
      // Das Element IST der hörbare Weg — LiveKit führt es, ``startAudio()``
      // spielt es (und soll es auch).
      const el = track.attach() as HTMLAudioElement;
      el.autoplay = true;
      this.#einhaengen(el);
      return;
    }
    const mst = track.mediaStreamTrack;
    if (!mst) return;
    const strom = new MediaStream([mst]);
    // Eigener stummer Anker, den LiveKit nicht kennt (s. Kopf der Datei).
    const anker = document.createElement('audio');
    this.#einhaengen(anker);
    ankerBefestigen(anker, strom);
    const ctx = this.#tonKontext();
    const quelle = ctx.createMediaStreamSource(strom);
    const zug = ctx.createGain();
    zug.gain.value = TON_MAKEUP;
    quelle.connect(zug);
    zug.connect(ctx.destination);
    const sid = track.sid;
    if (sid) this.#tonZuege.set(sid, { quelle, zug, anker });
  }

  /** Ein Track endet (Abbestellen): seine Elemente vom Track lösen und
   *  entfernen — ``detach()`` ohne Argument löst ALLE Elemente dieses Tracks
   *  und gibt sie zurück, mehr braucht es nicht — und bei einem Ton auch
   *  seinen Web-Audio-Zug. */
  loesen(track: RemoteTrack): void {
    for (const el of track.detach()) {
      el.remove();
      this.#audioEls.delete(el as HTMLAudioElement);
    }
    if (track.kind === Track.Kind.Audio) this.#tonLoesen((track as RemoteAudioTrack).sid);
  }

  /** Den Ton fortsetzen, falls der Browser den Kontext angehalten hat (oder
   *  einen Anker): die Gastseite hat keinen „Ton aktivieren“-Knopf. Safari lässt
   *  den Kontext, der beim ersten Ton MITTEN im Handschlag entsteht, angehalten
   *  (die Geste des Beitritts liegt zu weit zurück); gerufen wird deshalb, sobald
   *  das Mikrofon läuft und wenn LiveKit den Abspielstatus ändert. Klappt es
   *  nicht, setzt die nächste Geste auf der Seite fort (`kontextFortsetzen`). */
  fortsetzen(): void {
    if (this.#tonCtx) kontextFortsetzen(this.#tonCtx);
    for (const { anker } of this.#tonZuege.values()) {
      if (anker.paused) void anker.play().catch(() => undefined);
    }
  }

  /** Alles weg (Abbau des Raums): Elemente, Züge, Kontext. */
  alleLoesen(): void {
    for (const el of this.#audioEls) el.remove();
    this.#audioEls.clear();
    // Derselbe Weg wie beim Track-Unsubscribe (#tonLoesen): Züge lösen und
    // aus der Karte nehmen — keine zweite Kopie dieses Abbaus.
    for (const sid of this.#tonZuege.keys()) this.#tonLoesen(sid);
    if (this.#tonCtx) {
      void this.#tonCtx.close().catch(() => undefined);
      this.#tonCtx = null;
    }
  }

  /** Ein Ton-Element unsichtbar ins Dokument hängen und für den Abbau merken. */
  #einhaengen(el: HTMLAudioElement): void {
    el.style.display = 'none';
    document.body.appendChild(el);
    this.#audioEls.add(el);
  }

  #tonKontext(): AudioContext {
    if (!this.#tonCtx || this.#tonCtx.state === 'closed') {
      this.#tonCtx = new AudioContext();
    }
    kontextFortsetzen(this.#tonCtx);
    return this.#tonCtx;
  }

  #tonLoesen(sid: string | undefined): void {
    if (!sid) return;
    const zug = this.#tonZuege.get(sid);
    if (!zug) return;
    try {
      zug.quelle.disconnect();
    } catch {
      /* schon gelöst */
    }
    try {
      zug.zug.disconnect();
    } catch {
      /* schon gelöst */
    }
    ankerLoesen(zug.anker);
    zug.anker.remove();
    this.#audioEls.delete(zug.anker);
    this.#tonZuege.delete(sid);
  }
}
