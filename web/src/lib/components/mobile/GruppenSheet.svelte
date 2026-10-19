<script lang="ts">
  /**
   * Gruppen-Blatt — Mitglieder sehen, hinzufügen, entfernen, gehen.
   *
   * Der zweite fehlende Bildschirm von P0.4 (s. Übergabe §5): Die
   * Verwaltungs-API (`mitgliedHinzufuegen`, `mitgliedEntfernen`, `verlassen`)
   * hatte keinen Aufrufer. Jede Mutation schreibt die Server-Antwort in den
   * `privateGruppen`-Store — die Antwort ist die neue Gruppen-Wahrheit, ein
   * lokales Umflicken wäre nur eine zweite, schlechtere Kopie.
   *
   * **Hinzufügen nur aus den Freunden:** Es gibt keinen Einladungs-Link-Flow
   * (bewusst zurückgestellt) — Mitglieder werden direkt per `user_id`
   * hinzugefügt, und die einzige Quelle für passende `user_id`s sind die
   * eigenen Freunde. **Entfernen nur der Ersteller** (so begrenzt es das
   * Backend) und nie auf sich selbst.
   */
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import XIcon from '@lucide/svelte/icons/x';
  import CheckIcon from '@lucide/svelte/icons/check';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import BellOffIcon from '@lucide/svelte/icons/bell-off';
  import PhoneIcon from '@lucide/svelte/icons/phone';
  import { friends } from '$lib/stores/friends.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { gruppenApi, type PrivateGruppe } from '$lib/api/gruppen';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';

  let {
    gruppe,
    open = $bindable(false),
    onVerlassen,
    onAnrufen
  }: {
    gruppe: PrivateGruppe;
    open?: boolean;
    /** Nach dem Verlassen — der Aufrufer navigiert weg (Kanal existiert dann nicht mehr). */
    onVerlassen?: () => void;
    /** Gruppenanruf starten (Anrufe-Epic D). */
    onAnrufen?: () => void;
  } = $props();

  let freundeZumHinzufuegen = $derived(
    friends.list.filter((f) => !gruppe.members.some((mm) => mm.user_id === f.user_id))
  );
  /** Bin ich selbst noch dabei? Nach dem Verlassen bleibt der Chat lesbar —
   *  aber Verlassen (nochmal), Hinzufügen, Entfernen und Anrufen gehören
   *  dann der Vergangenheit an (Nutzerwunsch Testrunde 2026-09-24). */
  let istMitglied = $derived(
    gruppe.members.some((mm) => mm.user_id === currentServerUserId())
  );
  /** Entfernen-X: nur der Ersteller, nur andere, nur solange ER SELBST
   *  Mitglied ist — so begrenzt es das Backend. */
  let darfEntfernen = $derived(gruppe.ersteller_id === currentServerUserId() && istMitglied);
  let verlassenBestaetigt = $state(false);
  let aufloesenBestaetigt = $state(false);
  let amArbeiten = $state(false);
  let iconInput = $state<HTMLInputElement | undefined>();
  /** Umbenennen (Owner): Klick auf den Namen macht ihn zum Eingabefeld. */
  let umbenennenOffen = $state(false);
  let neuerName = $state('');

  $effect(() => {
    if (open) {
      verlassenBestaetigt = false;
      aufloesenBestaetigt = false;
      for (const mm of gruppe.members) userCache.queue(mm.user_id);
      for (const f of freundeZumHinzufuegen) userCache.queue(f.user_id);
    }
  });

  /** Meine Rolle (Rollen-Vertrag 2026-10-19): owner/admin/mitglied. */
  const eigeneRolle = $derived(
    gruppe.members.find((mm) => mm.user_id === currentServerUserId())?.rolle ?? null
  );
  const istOwner = $derived(eigeneRolle === 'owner');
  /** Einladen + Rauswerfen: Owner und Admins (einfache Mitglieder nicht). */
  const darfVerwalten = $derived(eigeneRolle === 'owner' || eigeneRolle === 'admin');
  /** Ein Mitglied kickt der Owner (jeden anderen) und Admins (nur
   *  einfache Mitglieder) — dieselbe Rechnung wie im Backend. */
  function darfKicken(zielRolle: string | undefined): boolean {
    if (!darfVerwalten) return false;
    if (istOwner) return true;
    return zielRolle === 'mitglied';
  }
  /** Der Stumm-Merker der eigenen Zeile (persönlich, pro Gerät synchron). */
  const ichStumm = $derived(
    gruppe.members.find((mm) => mm.user_id === currentServerUserId())?.stumm ?? false
  );

  async function umbenennen() {
    if (amArbeiten) return;
    const name = neuerName.trim();
    if (!name) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.umbenennen(gruppe.id, name);
      if (neu) privateGruppen.upsert(neu);
      umbenennenOffen = false;
    } catch (err) {
      aktionFehlgeschlagen(err);
    } finally {
      amArbeiten = false;
    }
  }

  async function aufloesen() {
    if (amArbeiten) return;
    if (!aufloesenBestaetigt) {
      aufloesenBestaetigt = true;
      return;
    }
    amArbeiten = true;
    try {
      await gruppenApi.aufloesen(gruppe.id);
      privateGruppen.entfernen(gruppe.id);
      open = false;
      onVerlassen?.();
    } catch (err) {
      aktionFehlgeschlagen(err);
    } finally {
      amArbeiten = false;
      aufloesenBestaetigt = false;
    }
  }

  async function stummUmschalten() {
    if (amArbeiten) return;
    const ich = currentServerUserId();
    if (!ich) return;
    amArbeiten = true;
    try {
      await gruppenApi.stummSetzen(gruppe.id, !ichStumm);
      privateGruppen.stummSetzen(gruppe.id, ich, !ichStumm);
    } catch (err) {
      aktionFehlgeschlagen(err);
    } finally {
      amArbeiten = false;
    }
  }

  /** Gruppenbild hochladen (Nutzerwunsch 2026-10-19). Antwort = neue
   *  Gruppen-Wahrheit — derselbe Weg wie bei den Mitglieds-Mutationen. */
  async function iconHochladen(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || amArbeiten) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.iconSetzen(gruppe.id, file);
      if (neu) privateGruppen.upsert(neu);
    } catch (err) {
      aktionFehlgeschlagen(err);
    } finally {
      amArbeiten = false;
    }
  }

  async function iconEntfernen() {
    if (amArbeiten) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.iconEntfernen(gruppe.id);
      if (neu) privateGruppen.upsert(neu);
    } catch (err) {
      aktionFehlgeschlagen(err);
    } finally {
      amArbeiten = false;
    }
  }

  async function hinzufuegen(userId: string) {
    if (amArbeiten) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.mitgliedHinzufuegen(gruppe.id, userId);
      if (neu) privateGruppen.upsert(neu);
    } catch (e) {
      aktionFehlgeschlagen(e);
    } finally {
      amArbeiten = false;
    }
  }

  async function entfernen(userId: string) {
    if (amArbeiten) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.mitgliedEntfernen(gruppe.id, userId);
      // `null` = Gruppe damit aufgelöst — dann ist hier auch Schluss.
      if (neu) privateGruppen.upsert(neu);
      else privateGruppen.entfernen(gruppe.id);
    } catch (e) {
      aktionFehlgeschlagen(e);
    } finally {
      amArbeiten = false;
    }
  }

  async function verlassen() {
    if (!verlassenBestaetigt) {
      verlassenBestaetigt = true;
      return;
    }
    if (amArbeiten) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.verlassen(gruppe.id);
      if (neu) privateGruppen.upsert(neu);
      else privateGruppen.entfernen(gruppe.id);
      open = false;
      onVerlassen?.();
    } catch (e) {
      aktionFehlgeschlagen(e);
    } finally {
      amArbeiten = false;
    }
  }

  function aktionFehlgeschlagen(e: unknown) {
    toast.error(m.gruppen_aktion_fehlgeschlagen(), {
      description: e instanceof Error ? e.message : undefined
    });
  }

  function initialen(anzName: string): string {
    return anzName.slice(0, 1).toUpperCase();
  }
</script>

<BottomSheet
  {open}
  testid="group-sheet"
  closeLabel={m.gruppen_blatt_schliessen()}
  panelClass="bg-popover text-popover-foreground border-border relative flex max-h-[80dvh] flex-col overflow-y-auto rounded-t-[22px] border-t pb-[var(--safe-bottom)] shadow-2xl"
  onClose={() => (open = false)}
>
  <div class="bg-border mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full"></div>
  <div class="px-4 pb-2">
    <div class="flex items-center gap-3">
      <div class="shrink-0">
        {#if gruppe.icon_url}
          <img
            src={gruppe.icon_url}
            alt=""
            class="size-14 rounded-full object-cover"
            data-testid="group-icon"
          />
        {:else}
          <span
            class="accent-gradient flex size-14 items-center justify-center rounded-full text-lg font-bold text-white"
            data-testid="group-icon-initials"
          >
            {initialen(gruppe.name)}
          </span>
        {/if}
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
                aufloesenBestaetigt = false;
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
        {#if istMitglied}
          <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <button
              type="button"
              class="text-primary hover:underline"
              onclick={() => iconInput?.click()}
              data-testid="group-icon-change"
            >
              {gruppe.icon_url
                ? m.gruppen_bild_ersetzen()
                : m.gruppen_bild_setzen()}
            </button>
            {#if gruppe.icon_url}
              <button
                type="button"
                class="text-text-muted hover:text-error hover:underline"
                onclick={iconEntfernen}
                data-testid="group-icon-remove"
              >
                {m.gruppen_bild_entfernen()}
              </button>
            {/if}
          </div>
        {/if}
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
        onclick={() => {
          open = false;
          onAnrufen();
        }}
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
  </div>

  <ul class="flex flex-col gap-0.5 px-2">
    {#each gruppe.members as mm (mm.user_id)}
      {@const anzName = userCache.displayName(mm.user_id)}
      {@const bild = safeAvatarUrl(userCache.get(mm.user_id)?.avatar_url ?? null)}
      <li class="flex items-center gap-3 rounded-xl p-2" data-testid={`group-member-${mm.user_id}`}>
        {#if bild}
          <img src={bild} alt="" class="size-9 shrink-0 rounded-full object-cover" />
        {:else}
          <span
            class="accent-gradient flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
            >{initialen(anzName)}</span
          >
        {/if}
        <span class="truncate text-sm font-semibold" style={nameStyle(mm.user_id)}>{anzName}</span>
        {#if mm.rolle === 'owner'}
          <span
            class="rounded-full bg-primary/20 px-1.5 py-0.5 text-2xs font-bold text-primary"
            data-testid={`group-member-role-${mm.user_id}`}
          >
            Owner
          </span>
        {:else if mm.rolle === 'admin'}
          <span
            class="rounded-full bg-bg-hover px-1.5 py-0.5 text-2xs font-bold text-text-bright"
            data-testid={`group-member-role-${mm.user_id}`}
          >
            Admin
          </span>
        {/if}
        {#if darfKicken(mm.rolle) && mm.user_id !== currentServerUserId()}
          <button
            type="button"
            class="text-text-muted hover:text-error ml-auto flex size-9 handy:size-11 items-center justify-center rounded-full"
            onclick={() => entfernen(mm.user_id)}
            aria-label={m.gruppen_mitglied_entfernen()}
            data-testid={`group-member-remove-${mm.user_id}`}
          >
            <XIcon class="size-4" />
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if darfVerwalten && freundeZumHinzufuegen.length > 0}
    <p class="text-text-muted mt-3 px-4 pb-1 text-xs font-bold uppercase">
      {m.gruppen_blatt_hinzufuegen_kopf()}
    </p>
    <ul class="flex flex-col gap-0.5 px-2">
      {#each freundeZumHinzufuegen as f (f.user_id)}
        {@const anzName = userCache.displayName(f.user_id)}
        <li class="flex items-center gap-3 rounded-xl p-2">
          <span
            class="accent-gradient flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
            >{initialen(anzName)}</span
          >
          <span class="truncate text-sm font-semibold" style={nameStyle(f.user_id)}>{anzName}</span>
          <button
            type="button"
            class="text-primary hover:bg-bg-hover ml-auto flex size-9 handy:size-11 items-center justify-center rounded-full"
            onclick={() => hinzufuegen(f.user_id)}
            aria-label={m.gruppen_mitglied_hinzufuegen()}
            data-testid={`group-member-add-${f.user_id}`}
          >
            <UserPlusIcon class="size-4" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if istMitglied}
    <div class="mt-4 px-4 pb-2">
      <button
        type="button"
        class="flex min-h-11 w-full items-center justify-center rounded-xl border border-red-500/40 py-2.5 text-sm font-bold text-red-500"
        onclick={verlassen}
        data-testid="group-leave"
      >
        {verlassenBestaetigt
          ? m.gruppen_blatt_verlassen_bestaetigen()
          : m.gruppen_blatt_verlassen()}
      </button>
      {#if istOwner}
        <!-- Auflösen (Owner): räumt die Gruppe für ALLE ab — doppelte
             Bestätigung wie beim Verlassen. -->
        <button
          type="button"
          class="mt-2 flex min-h-11 w-full items-center justify-center rounded-xl bg-red-500/15 py-2.5 text-sm font-bold text-red-500"
          onclick={aufloesen}
          data-testid="group-dissolve"
        >
          {aufloesenBestaetigt
            ? m.gruppen_aufloesen_bestaetigen()
            : m.gruppen_aufloesen()}
        </button>
      {/if}
    </div>
  {/if}
</BottomSheet>
