<script lang="ts">
  /**
   * Kopf des Gruppen-Blatts — Bild, Name (Owner: umbenennen), Bild setzen/
   * entfernen, Gruppenanruf und die eigene Stummschaltung.
   *
   * Mutationen laufen über `ausfuehren` aus dem Blatt (eine zur Zeit, Fehler
   * als Hinweis). Antwortet die Route mit der Gruppe, ist das die neue
   * Wahrheit für den Store — derselbe Weg wie bei den Mitglieds-Mutationen.
   */
  import XIcon from '@lucide/svelte/icons/x';
  import CheckIcon from '@lucide/svelte/icons/check';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import BellOffIcon from '@lucide/svelte/icons/bell-off';
  import PhoneIcon from '@lucide/svelte/icons/phone';
  import { gruppenApi, type PrivateGruppe } from '$lib/api/gruppen';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    gruppe,
    ichId,
    istMitglied,
    istOwner,
    ausfuehren,
    onAnrufen,
    onUmbenennenAbbruch
  }: {
    gruppe: PrivateGruppe;
    ichId: string | null;
    istMitglied: boolean;
    istOwner: boolean;
    ausfuehren: (fn: () => Promise<void>) => Promise<void>;
    /** Gruppenanruf starten — das Blatt schließt sich dabei selbst. */
    onAnrufen?: () => void;
    /** Abbruch des Umbenennens nimmt auch eine offene Auflösen-Bestätigung zurück. */
    onUmbenennenAbbruch: () => void;
  } = $props();

  let iconInput = $state<HTMLInputElement | undefined>();
  /** Umbenennen (Owner): Klick auf den Stift macht den Namen zum Eingabefeld. */
  let umbenennenOffen = $state(false);
  let neuerName = $state('');
  /** Persönlich, pro Gerät synchron — einzige Lesestelle im Store. */
  const ichStumm = $derived(privateGruppen.eigenesStumm(gruppe, ichId));

  function umbenennen() {
    const name = neuerName.trim();
    if (!name) return;
    void ausfuehren(async () => {
      const neu = await gruppenApi.umbenennen(gruppe.id, name);
      if (neu) privateGruppen.upsert(neu);
      umbenennenOffen = false;
    });
  }

  function stummUmschalten() {
    const ich = ichId;
    if (!ich) return;
    // Einmal vorher festhalten: nach dem `await` sähe `ichStumm` womöglich
    // schon den Stand, den ein Gruppen-Ereignis inzwischen eingetragen hat.
    const neu = !ichStumm;
    void ausfuehren(async () => {
      await gruppenApi.stummSetzen(gruppe.id, neu);
      privateGruppen.stummSetzen(gruppe.id, ich, neu);
    });
  }

  /** Gruppenbild hochladen (Nutzerwunsch 2026-10-19). */
  function iconHochladen(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void ausfuehren(async () => {
      const neu = await gruppenApi.iconSetzen(gruppe.id, file);
      if (neu) privateGruppen.upsert(neu);
    });
  }
</script>

<div class="flex items-center gap-3">
  <div class="shrink-0">
    <!-- Tipp auf den Kreis = Bild wählen (Nutzerwunsch 2026-10-19); der
         Pfeil unten rechts zeigt, dass hier etwas zu holen ist. Die
         Text-Links (setzen/ersetzen/entfernen) sind bewusst weg. -->
    <button
      type="button"
      class="relative block cursor-pointer rounded-full"
      onclick={() => iconInput?.click()}
      aria-label={gruppe.icon_url ? m.gruppen_bild_ersetzen() : m.gruppen_bild_setzen()}
      data-testid="group-icon-change"
    >
      {#if gruppe.icon_url}
        <img src={gruppe.icon_url} alt="" class="size-14 rounded-full object-cover" data-testid="group-icon" />
      {:else}
        <span
          class="accent-gradient flex size-14 items-center justify-center rounded-full text-lg font-bold text-white"
          data-testid="group-icon-initials"
        >
          {gruppe.name.slice(0, 1).toUpperCase()}
        </span>
      {/if}
      <span
        class="bg-bg-input ring-border text-text-muted absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full ring-2"
        aria-hidden="true"
      >
        <ChevronRightIcon class="size-3" />
      </span>
    </button>
  </div>
  <div class="min-w-0 flex-1">
    {#if umbenennenOffen}
      <!-- Umbenennen (Owner): Eingabe + Haken, Abbruch mit dem X. -->
      <div class="flex items-center gap-2">
        <input
          bind:value={neuerName}
          class="text-text-bright border-primary min-w-0 flex-1 rounded-lg border px-2 py-1 text-base font-bold outline-none"
          maxlength="64"
          data-testid="group-rename-input"
        />
        <button
          type="button"
          class="text-primary flex size-8 shrink-0 items-center justify-center"
          onclick={umbenennen}
          aria-label={m.gruppen_speichern()}
          data-testid="group-rename-save"
        >
          <CheckIcon class="size-4" />
        </button>
        <button
          type="button"
          class="text-text-muted flex size-8 shrink-0 items-center justify-center"
          onclick={() => {
            umbenennenOffen = false;
            onUmbenennenAbbruch();
          }}
          aria-label={m.gruppen_abbrechen()}
        >
          <XIcon class="size-4" />
        </button>
      </div>
    {:else}
      <div class="flex items-center gap-2">
        <p class="text-text-bright truncate text-base font-bold">{gruppe.name}</p>
        {#if istOwner}
          <button
            type="button"
            class="text-text-muted hover:text-primary shrink-0"
            onclick={() => {
              neuerName = gruppe.name;
              umbenennenOffen = true;
            }}
            aria-label={m.gruppen_umbenennen()}
            data-testid="group-rename-open"
          >
            <PencilIcon class="size-3.5" />
          </button>
        {/if}
      </div>
    {/if}
    <p class="text-text-muted text-xs">
      {m.gruppen_blatt_mitglieder({ count: gruppe.members.length })}
    </p>
  </div>
</div>
<input
  bind:this={iconInput}
  type="file"
  accept="image/png,image/jpeg,image/webp"
  class="hidden"
  onchange={iconHochladen}
/>
{#if onAnrufen && istMitglied}
  <button
    type="button"
    class="text-primary hover:bg-bg-hover mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-border py-2 text-sm font-semibold"
    onclick={onAnrufen}
    data-testid="group-call-button"
  >
    <PhoneIcon class="size-4" />
    {m.anruf_starten()}
  </button>
{/if}
{#if istMitglied}
  <!-- Stumm: persönlich, pro Gerät synchronisiert — der Handy-Push der
       Gruppe ruht, der Chat selbst bleibt normal. -->
  <button
    type="button"
    class="hover:bg-bg-hover mt-2 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-sm font-semibold {ichStumm
      ? 'text-text-bright'
      : 'text-text-base'}"
    onclick={stummUmschalten}
    data-testid="group-mute"
  >
    <span class="flex items-center gap-2">
      <BellOffIcon class="size-4" />
      {m.gruppen_stumm()}
    </span>
    <span class={ichStumm ? 'text-primary' : 'text-text-muted'}>
      {ichStumm ? m.gruppen_stumm_an() : m.gruppen_stumm_aus()}
    </span>
  </button>
{/if}
