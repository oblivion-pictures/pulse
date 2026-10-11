<!--
  BildImBildKnopf — schickt ein `<video>` ins System-Bild-in-Bild und holt es
  zurück (iOS-Roadmap Punkt 29). Erscheint nur, wenn der Weg wirklich trägt
  (`stream/systemBildImBild.ts`); ohne die Fähigkeit gibt es keinen Knopf,
  statt eines Knopfes, der nichts tut.

  **Nur in der iOS-Hülle.** Gefragt war das Telefon; dieselbe Fähigkeit
  hätten auch Safari und Chrome auf Android-Telefonen. Ob der Knopf dort
  ebenfalls erscheinen soll, ist eine Produktfrage — die Zeile `erlaubt`
  entscheidet es.

  **Automatisch beim Verlassen der App gibt es auf diesem Weg nicht.** Beide
  Schnittstellen verlangen eine Nutzergeste, und wenn `visibilitychange`
  feuert, ist die App schon im Hintergrund.
-->
<script lang="ts">
  import PictureInPicture2Icon from '@lucide/svelte/icons/picture-in-picture-2';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { isCapacitorIOS } from '$lib/platform/runtime';
  import {
    BILD_IM_BILD_EREIGNISSE,
    bildImBildAktiv,
    bildImBildUmschalten,
    bildImBildWeg
  } from '../systemBildImBild';

  let {
    video,
    klasse,
    testid,
    symbol = 'size-5',
    /** In der Kachel: im Eckfenster ausblenden, dort hat dessen eigene
     *  Steuerung den Knopf (`app.css`, `[data-pip-hide]`). */
    pipHide = false,
    /** Nach einem Druck, egal wie er ausging — das Eckfenster blendet damit
     *  seine Steuerung aus. */
    gedrueckt
  }: {
    video: HTMLVideoElement | null;
    klasse: string;
    testid: string;
    symbol?: string;
    pipHide?: boolean;
    gedrueckt?: () => void;
  } = $props();

  const erlaubt = isCapacitorIOS();
  let moeglich = $state(false);
  let aktiv = $state(false);
  const beschriftung = $derived(aktiv ? m.tile_shell_pip_exit() : m.tile_shell_pip_enter());

  $effect(() => {
    const v = video;
    if (!erlaubt || !v) {
      moeglich = false;
      aktiv = false;
      return;
    }
    const lesen = () => {
      moeglich = bildImBildWeg(v, document) !== null;
      aktiv = bildImBildAktiv(v, document);
    };
    lesen();
    for (const e of BILD_IM_BILD_EREIGNISSE) v.addEventListener(e, lesen);
    return () => {
      for (const e of BILD_IM_BILD_EREIGNISSE) v.removeEventListener(e, lesen);
    };
  });

  async function umschalten(): Promise<void> {
    if (!video) return;
    gedrueckt?.();
    const r = await bildImBildUmschalten(video, document);
    if (r.ergebnis === 'fehler') {
      console.warn('[bild-im-bild] abgelehnt:', r.grund);
      toast.error(m.tile_shell_pip_failed());
    }
  }
</script>

{#if moeglich || aktiv}
  <button
    type="button"
    class="{klasse} {aktiv ? '!text-primary' : ''}"
    onpointerdown={(e) => e.stopPropagation()}
    onclick={umschalten}
    aria-label={beschriftung}
    title={beschriftung}
    data-pip-hide={pipHide ? '' : undefined}
    data-testid={testid}
  >
    <PictureInPicture2Icon class={symbol} />
  </button>
{/if}
