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
   * eigenen Freunde. Einladen und Rauswerfen dürfen Owner und Admins, die
   * Rollen verwaltet allein der Owner (Rollen-Vertrag 2026-10-19).
   *
   * Aufgeteilt: Kopf (Bild, Name, Anruf, Stumm) in `GruppenKopf.svelte`,
   * eine Mitgliederzeile samt Rollen-Aktionen in `GruppenMitgliedZeile.svelte`.
   * Die Sperre „eine Mutation zur Zeit" und der Fehler-Hinweis bleiben hier
   * (`ausfuehren`) und gelten für alle drei.
   */
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import GruppenKopf from '$lib/components/mobile/GruppenKopf.svelte';
  import GruppenMitgliedZeile from '$lib/components/mobile/GruppenMitgliedZeile.svelte';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import { friends } from '$lib/stores/friends.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
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
  const ichId = $derived(currentServerUserId());
  /** Bin ich selbst noch dabei? Nach dem Verlassen bleibt der Chat lesbar —
   *  aber Verlassen (nochmal), Hinzufügen, Entfernen und Anrufen gehören
   *  dann der Vergangenheit an (Nutzerwunsch Testrunde 2026-09-24). */
  let istMitglied = $derived(gruppe.members.some((mm) => mm.user_id === ichId));
  let verlassenBestaetigt = $state(false);
  let aufloesenBestaetigt = $state(false);
  let amArbeiten = $state(false);

  $effect(() => {
    if (open) {
      verlassenBestaetigt = false;
      aufloesenBestaetigt = false;
      for (const mm of gruppe.members) userCache.queue(mm.user_id);
      for (const f of freundeZumHinzufuegen) userCache.queue(f.user_id);
    }
  });

  /** Meine Rolle (Rollen-Vertrag 2026-10-19): owner/admin/mitglied. */
  const eigeneRolle = $derived(gruppe.members.find((mm) => mm.user_id === ichId)?.rolle ?? null);
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

  /** Eine Mutation zur Zeit; ein Fehlschlag wird als Hinweis gezeigt. */
  async function ausfuehren(fn: () => Promise<void>): Promise<void> {
    if (amArbeiten) return;
    amArbeiten = true;
    try {
      await fn();
    } catch (e) {
      toast.error(m.gruppen_aktion_fehlgeschlagen(), {
        description: e instanceof Error ? e.message : undefined
      });
    } finally {
      amArbeiten = false;
    }
  }

  function aufloesen() {
    if (amArbeiten) return;
    if (!aufloesenBestaetigt) {
      aufloesenBestaetigt = true;
      return;
    }
    void ausfuehren(async () => {
      await gruppenApi.aufloesen(gruppe.id);
      privateGruppen.entfernen(gruppe.id);
      open = false;
      onVerlassen?.();
    }).finally(() => (aufloesenBestaetigt = false));
  }

  function hinzufuegen(userId: string) {
    void ausfuehren(async () => {
      const neu = await gruppenApi.mitgliedHinzufuegen(gruppe.id, userId);
      if (neu) privateGruppen.upsert(neu);
    });
  }

  function verlassen() {
    if (!verlassenBestaetigt) {
      verlassenBestaetigt = true;
      return;
    }
    void ausfuehren(async () => {
      const neu = await gruppenApi.verlassen(gruppe.id);
      if (neu) privateGruppen.upsert(neu);
      else privateGruppen.entfernen(gruppe.id);
      open = false;
      onVerlassen?.();
    });
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
    <GruppenKopf
      {gruppe}
      {ichId}
      {istMitglied}
      {istOwner}
      {ausfuehren}
      onAnrufen={onAnrufen
        ? () => {
            open = false;
            onAnrufen();
          }
        : undefined}
      onUmbenennenAbbruch={() => (aufloesenBestaetigt = false)}
    />
  </div>

  <ul class="flex flex-col gap-0.5 px-2">
    {#each gruppe.members as mm (mm.user_id)}
      <GruppenMitgliedZeile
        gruppeId={gruppe.id}
        {mm}
        {ichId}
        darfKicken={darfKicken(mm.rolle)}
        {istOwner}
        {ausfuehren}
      />
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
            >{anzName.slice(0, 1).toUpperCase()}</span
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
