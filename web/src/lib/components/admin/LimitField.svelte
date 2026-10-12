<!--
  Ein Zahlenfeld in den Community-Grenzen: Beschriftung + Eingabe + Platzhalter.

  Der Platzhalter ist der Punkt dieser Komponente. Vorher stand in jedem leeren
  Feld nur „Standard" — das beantwortet die eine Frage nicht, die man beim
  Ausfüllen hat: *welcher* Standard? Deshalb nimmt sie den tatsächlich
  wirkenden Wert entgegen und zeigt ihn an („Standard: 128"). Wo es keinen
  Zahlenwert gibt, weil leer schlicht „ohne Grenze" heißt, steht „Unbegrenzt".

  `keep`: leer bedeutet hier „nicht ändern" statt „Standard" (die zwei
  Datei-Obergrenzen). Der Platzhalter sagt dann „Aktuell: …" — „Standard: 50"
  wäre falsch, sobald 50 eine Anhebung des Betreibers ist.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    label,
    value = $bindable(''),
    fallback,
    testid,
    min,
    max,
    step,
    keep = false
  }: {
    label: string;
    value?: string | number;
    /** Was gilt, wenn das Feld leer bleibt: eine Zahl (der geerbte Standard,
     *  bereits in der Einheit des Feldes) oder 'unlimited'. */
    fallback: number | 'unlimited';
    testid: string;
    min?: string;
    max?: string;
    step?: string;
    /** Leer = unverändert lassen; der Platzhalter nennt den aktuellen Wert. */
    keep?: boolean;
  } = $props();

  // Zahlen werden mit der Locale des Browsers gesetzt (1000 → „1.000"), damit
  // der Platzhalter so aussieht wie das, was der Betreiber sonst liest.
  const placeholder = $derived.by(() => {
    if (fallback === 'unlimited') return m.admin_communities_limits_placeholder_unlimited();
    const value = new Intl.NumberFormat().format(fallback);
    return keep
      ? m.admin_communities_limits_placeholder_current({ value })
      : m.admin_communities_limits_placeholder_default({ value });
  });
</script>

<label class="flex flex-col gap-1">
  <span class="text-text-muted text-xs font-medium">{label}</span>
  <Input type="number" {min} {max} {step} {placeholder} bind:value data-testid={testid} />
</label>
