<!--
  Codec-Feld des Standplatz-Profils — herausgelöst aus
  `SettingsStandplatzProfil.svelte` (Größengrenze), mitsamt der Regel, dass nur
  angeboten wird, was die Karte dieses Rechners encodieren kann
  (`$lib/devices/profilCodec.ts`, dort steht auch der Anlass).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Select from '$lib/components/form/Select.svelte';
  import { kartenFaehigkeit, kartenFaehigkeitSicherstellen } from '$lib/devices/kartenFaehigkeit';
  import {
    PROFIL_CODECS,
    profilCodecFuerKarte,
    profilCodecOptionen,
    type ProfilCodec,
  } from '$lib/devices/profilCodec';
  import { m } from '$lib/paraglide/messages.js';

  let { codec = $bindable() }: { codec: ProfilCodec } = $props();

  // Die Encoder-Probe selbst beschaffen, statt zu hoffen, dass sie schon da
  // ist: gefüllt wird sie sonst nur vom Stream-Dialog (`kartenFaehigkeit.ts`).
  // `onMount`, nicht `$effect`: die Funktion liest `gpu_info` und schreibt es —
  // ein Effekt liefe bei jeder unvollständigen Antwort erneut los.
  onMount(() => {
    void kartenFaehigkeitSicherstellen();
  });

  const karte = $derived(kartenFaehigkeit());
  const optionen = $derived.by(() => {
    const angeboten = profilCodecOptionen(karte);
    return PROFIL_CODECS.filter((c) => angeboten.includes(c.value));
  });

  // Ein hier nicht einlösbarer gespeicherter Codec rückt im Entwurf auf die
  // nächste Stufe, wie im normalen Codec-Feld (`codecAnpassungFuerGpu`) — sonst
  // stünde das Feld leer, weil kein angebotener Eintrag den Wert trägt.
  $effect(() => {
    const passend = profilCodecFuerKarte(codec, karte);
    if (passend !== codec) codec = passend;
  });
</script>

<label class="flex flex-col gap-1">
  <span class="text-text-muted text-xs">{m.standplatz_profil_codec()}</span>
  <Select
    value={codec}
    options={optionen}
    onchange={(v) => (codec = v as ProfilCodec)}
    data-testid="standplatz-profil-codec"
  />
</label>
