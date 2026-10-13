/**
 * Doppelter Ton: LiveKits `room.startAudio()` darf kein Element entstummen, das
 * Pulse stumm hält, weil der Ton über einen eigenen Web-Audio-Zug läuft.
 *
 * `startAudio()` setzt `muted = false` für JEDES Element, das per
 * `track.attach()` an einen fernen Audio-Track hängt (`livekit-client`,
 * `Room.startAudio`). Pulse hatte an zwei Stellen so einen „stummen Anker“:
 * die Bildschirmfreigabe-Kachel (Boost bis 200 %) und den Desktop-Gast
 * (4×-Zug). Der nächste `startAudio()` — erstes Mikrofon, eigene Freigabe mit
 * Ton, „Ton aktivieren“, die Wiederholung aus `audio/abspielen.ts` — machte sie
 * hörbar, und Element plus Zug spielten denselben Ton. Seither bekommt der Zug
 * ein EIGENES Element, das LiveKit nicht kennt (`audio/stummerAnker.ts`).
 *
 * Wie in `abspielen-abbruch.spec.ts` läuft die echte Bibliothek ohne Server:
 * echte `RemoteAudioTrack`s über Test-Tönen, ein echter `Room`, dessen
 * `startAudio()` genau diese Spuren findet — und die ECHTE Kachel
 * (`ScreenShareTile`) bzw. das echte Gast-Modul (`GastTon`) darunter. Gehört
 * wird hier nichts; belegt ist der Zustand der Elemente (`muted`, `paused`) und
 * wer sie führt (`track.attachedElements`).
 *
 * Die Kontrolle ohne Zutun von Pulse ist Absicht: sie beweist, dass diese
 * LiveKit-Fassung ein angehängtes Element wirklich entstummt. Wird sie rot, hat
 * LiveKit das Verhalten geändert — dann kann der Anker einfacher werden.
 */
import { test, expect, type Page } from '@playwright/test';

const HILFE = '/tests/e2e/_tonKachel.ts';

test.describe('startAudio() und die stummen Anker', () => {
  // Der erste Import zieht den halben App-Baum durch den Vite-Dev-Server.
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await bereit(page);
  });

  test('Kontrolle: LiveKits startAudio() entstummt ein angehängtes Element', async ({ page }) => {
    const b = await page.evaluate(
      async ([hilfe]) => {
        const h = await import(/* @vite-ignore */ hilfe);
        const ton = h.tonSpur('TR_kontrolle');
        const el = ton.attach() as HTMLAudioElement;
        document.body.appendChild(el);
        el.muted = true; // so hält Pulse den Anker, wenn der Zug den Ton trägt
        await h.raumMit(ton).startAudio().catch(() => undefined);
        return { muted: el.muted, gefuehrt: ton.attachedElements.length };
      },
      [HILFE]
    );
    expect(b.gefuehrt).toBe(1);
    expect(b.muted, 'Kontrolle: genau das passierte mit dem Anker, solange er per attach() hing').toBe(
      false
    );
  });

  test.describe('Bildschirmfreigabe-Kachel', () => {
    /** Kachel einhängen, optional AudioContext-Aufrufe zählen, `startAudio()` fahren. */
    function fahre(page: Page, opts: { ohneWebAudio?: boolean } = {}) {
      return page.evaluate(
        async ([hilfe, opts]) => {
          const h = await import(/* @vite-ignore */ hilfe);
          const ton = h.tonSpur('TR_kachel');
          const bild = h.bildSpur('TR_bild');
          const Echt = window.AudioContext;
          const kontexte: AudioContext[] = [];
          // Ohne AudioContext kommt der Web-Audio-Zug nicht zustande (Rückfall).
          if (opts.ohneWebAudio) {
            // @ts-expect-error - Rückfallweg nachstellen
            window.AudioContext = undefined;
          } else {
            window.AudioContext = class extends Echt {
              constructor(...a: ConstructorParameters<typeof AudioContext>) {
                super(...a);
                kontexte.push(this);
              }
            };
          }
          const aushaengen = h.kachelEinhaengen(ton, bild);
          await new Promise((r) => setTimeout(r, 500));
          window.AudioContext = Echt;
          const el = document.querySelector('audio') as HTMLAudioElement;
          const vorher = { muted: el.muted, paused: el.paused };
          await h.raumMit(ton).startAudio().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 200));
          const nachher = { muted: el.muted, paused: el.paused };
          const gefuehrt = ton.attachedElements.length;
          aushaengen();
          await new Promise((r) => setTimeout(r, 200));
          return {
            vorher,
            nachher,
            gefuehrt,
            kontexteBeiAbbau: kontexte.map((k) => k.state),
            elementeNachAbbau: document.querySelectorAll('audio').length
          };
        },
        [HILFE, opts] as const
      );
    }

    test('der Anker bleibt nach startAudio() stumm und gehört LiveKit nicht', async ({ page }) => {
      const b = await fahre(page);
      expect(b.vorher.muted).toBe(true);
      expect(b.nachher.muted, 'startAudio() hat den Anker entstummt — der Ton liefe doppelt').toBe(true);
      expect(b.nachher.paused, 'der Anker hält den Decoder, er muss laufen').toBe(false);
      expect(b.gefuehrt, 'LiveKit darf den Anker nicht führen').toBe(0);
    });

    test('Abbau: Anker weg, der Web-Audio-Kontext zu', async ({ page }) => {
      const b = await fahre(page);
      expect(b.elementeNachAbbau).toBe(0);
      expect(b.kontexteBeiAbbau.length, 'genau ein Kontext für den Zug').toBe(1);
      expect(b.kontexteBeiAbbau).toEqual(['closed']);
    });

    test('Rückfall ohne Web-Audio-Zug: das Element ist hörbar und LiveKit führt es', async ({
      page
    }) => {
      const b = await fahre(page, { ohneWebAudio: true });
      expect(b.vorher.muted, 'ohne Zug ist das Element der einzige Weg zum Ton').toBe(false);
      expect(b.nachher.muted).toBe(false);
      expect(b.gefuehrt, 'im Rückfall führt LiveKit das Element (startAudio, Ausgabegerät)').toBe(1);
    });

    test('Stummschalten und Lautstärke wirken auf den Zug, der Anker bleibt stumm', async ({
      page
    }) => {
      const b = await page.evaluate(
        async ([hilfe]) => {
          const h = await import(/* @vite-ignore */ hilfe);
          // Alle Schreibzugriffe auf AudioParam.value mitlesen: der Zug setzt
          // seinen Gain darüber (`VolumeBoost.setVolume`).
          const beschr = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value')!;
          const gain: number[] = [];
          Object.defineProperty(AudioParam.prototype, 'value', {
            ...beschr,
            set(v: number) {
              gain.push(v);
              beschr.set!.call(this, v);
            }
          });
          const ton = h.tonSpur('TR_regler');
          h.kachelEinhaengen(ton, h.bildSpur('TR_bild2'));
          await new Promise((r) => setTimeout(r, 500));
          const el = document.querySelector('audio') as HTMLAudioElement;
          const regler = document.querySelector('[data-testid="screen-share-volume"]') as HTMLInputElement;
          const stumm = document.querySelector('[data-testid="screen-share-mute"]') as HTMLButtonElement;
          const letzter = () => gain[gain.length - 1];
          const anfang = letzter();
          stumm.click();
          await new Promise((r) => setTimeout(r, 300));
          const nachStumm = letzter();
          stumm.click();
          await new Promise((r) => setTimeout(r, 300));
          const nachLaut = letzter();
          regler.value = '200';
          regler.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const nachBoost = letzter();
          await h.raumMit(ton).startAudio().catch(() => undefined);
          return {
            anfang,
            nachStumm,
            nachLaut,
            nachBoost,
            ankerStumm: el.muted,
            ankerLaeuft: !el.paused,
            gefuehrt: ton.attachedElements.length
          };
        },
        [HILFE]
      );
      expect(b.anfang).toBe(1);
      expect(b.nachStumm).toBe(0);
      expect(b.nachLaut).toBe(1);
      expect(b.nachBoost, '200 % = Gain 2, nur über Web Audio möglich').toBe(2);
      expect(b.ankerStumm).toBe(true);
      expect(b.ankerLaeuft).toBe(true);
      expect(b.gefuehrt).toBe(0);
    });

    test('Ausgabegerät: der Anker folgt der Einstellung (LiveKit kennt ihn nicht mehr)', async ({
      page
    }) => {
      const b = await page.evaluate(
        async ([hilfe]) => {
          const h = await import(/* @vite-ignore */ hilfe);
          // @ts-expect-error - Vite-served path resolved at browser runtime
          const { settings } = await import('/src/lib/stores/settings.svelte.ts');
          const aufrufe: { tag: string; id: string }[] = [];
          (HTMLMediaElement.prototype as unknown as { setSinkId: unknown }).setSinkId = function (
            this: HTMLMediaElement,
            id: string
          ) {
            aufrufe.push({ tag: this.tagName, id });
            return Promise.resolve();
          };
          settings.setOutputDevice('geraet-1', 'Erstes');
          h.kachelEinhaengen(h.tonSpur('TR_geraet'), h.bildSpur('TR_bild3'));
          await new Promise((r) => setTimeout(r, 500));
          const beimStart = aufrufe.filter((a) => a.tag === 'AUDIO').map((a) => a.id);
          settings.setOutputDevice('geraet-2', 'Zweites');
          await new Promise((r) => setTimeout(r, 300));
          const nachWechsel = aufrufe.filter((a) => a.tag === 'AUDIO').map((a) => a.id);
          return { beimStart, nachWechsel };
        },
        [HILFE]
      );
      expect(b.beimStart).toContain('geraet-1');
      expect(b.nachWechsel.at(-1)).toBe('geraet-2');
    });
  });

  test.describe('Gast', () => {
    /** `GastTon` anhängen und `startAudio()` fahren. */
    function fahre(page: Page, mobil: boolean) {
      return page.evaluate(
        async ([hilfe, mobil]) => {
          const h = await import(/* @vite-ignore */ hilfe);
          // @ts-expect-error - Vite-served path resolved at browser runtime
          const { GastTon } = await import('/src/lib/gast/gastTon.ts');
          const ton = h.tonSpur('TR_gast');
          const gast = new GastTon(() => mobil);
          const vorher = document.querySelectorAll('audio').length;
          gast.anhaengen(ton);
          const els = [...document.querySelectorAll('audio')].slice(vorher) as HTMLAudioElement[];
          const lies = () => els.map((e) => ({ muted: e.muted, paused: e.paused }));
          const anfang = lies();
          await h.raumMit(ton).startAudio().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 200));
          const nachher = lies();
          const gefuehrt = ton.attachedElements.length;
          gast.loesen(ton);
          await new Promise((r) => setTimeout(r, 100));
          const nachLoesen = document.querySelectorAll('audio').length - vorher;
          gast.alleLoesen();
          return { anzahl: els.length, anfang, nachher, gefuehrt, nachLoesen };
        },
        [HILFE, mobil] as const
      );
    }

    test('Desktop: der Anker bleibt nach startAudio() stumm und gehört LiveKit nicht', async ({
      page
    }) => {
      const b = await fahre(page, false);
      expect(b.anzahl).toBe(1);
      expect(b.anfang).toEqual([{ muted: true, paused: false }]);
      expect(b.nachher, 'startAudio() hat den Anker entstummt — 4×-Zug und Element spielten gleichzeitig').toEqual([
        { muted: true, paused: false }
      ]);
      expect(b.gefuehrt).toBe(0);
    });

    test('Desktop: ein Track-Ende räumt den Anker ab', async ({ page }) => {
      const b = await fahre(page, false);
      expect(b.nachLoesen).toBe(0);
    });

    test('mobil: das Element ist der hörbare Weg, LiveKit führt und spielt es', async ({ page }) => {
      const b = await fahre(page, true);
      expect(b.anfang[0].muted).toBe(false);
      expect(b.nachher).toEqual([{ muted: false, paused: false }]);
      expect(b.gefuehrt).toBe(1);
      expect(b.nachLoesen).toBe(0);
    });
  });

  test('Mitglieder-Stimmen (RemoteAudioElements) hatten den Fehler nie', async ({ page }) => {
    const b = await page.evaluate(
      async ([hilfe]) => {
        const h = await import(/* @vite-ignore */ hilfe);
        // @ts-expect-error - Vite-served path resolved at browser runtime
        const { RemoteAudioElements } = await import('/src/lib/voice/audioElements.ts');
        const ton = h.tonSpur('TR_stimme');
        const stimmen = new RemoteAudioElements();
        const vorher = document.querySelectorAll('audio').length;
        stimmen.attach(ton, 'u1', () => undefined);
        const anker = [...document.querySelectorAll('audio')].slice(vorher) as HTMLAudioElement[];
        await h.raumMit(ton).startAudio().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 200));
        const r = {
          anzahl: anker.length,
          muted: anker.map((e) => e.muted),
          gefuehrt: ton.attachedElements.length
        };
        stimmen.destroy();
        return r;
      },
      [HILFE]
    );
    expect(b.anzahl).toBe(1);
    expect(b.gefuehrt, 'eigenes Element per createElement, nie per attach()').toBe(0);
    expect(b.muted).toEqual([true]);
  });
});

/**
 * Seite auf `/login` bereit machen: der erste Import des Hilfsmoduls lässt Vite
 * neu entdeckte Abhängigkeiten bündeln und die Seite EINMAL neu laden — das
 * zerstört jeden laufenden `evaluate`. Hier so lange importieren, bis ein Import
 * ohne Neuladen durchgeht.
 */
async function bereit(page: Page): Promise<void> {
  let navigiert = 0;
  page.on('framenavigated', () => navigiert++);
  for (let versuch = 0; versuch < 6; versuch++) {
    const vorher = navigiert;
    try {
      await page.evaluate(async ([hilfe]) => {
        await import(/* @vite-ignore */ hilfe);
        // @ts-expect-error - Vite-served path resolved at browser runtime
        await import('/src/lib/gast/gastTon.ts');
        // @ts-expect-error - Vite-served path resolved at browser runtime
        await import('/src/lib/voice/audioElements.ts');
        // @ts-expect-error - Vite-served path resolved at browser runtime
        await import('/src/lib/stores/settings.svelte.ts');
      }, [HILFE]);
    } catch {
      // Seite wurde neu geladen — noch einmal.
    }
    await page.waitForLoadState('load');
    await page.waitForTimeout(1_000);
    if (navigiert === vorher) return;
  }
  throw new Error('Vite hat die Seite nicht zur Ruhe kommen lassen');
}
