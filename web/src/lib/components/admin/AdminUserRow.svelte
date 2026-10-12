<!--
  Eine Zeile der Admin-User-Liste: Avatar + Name/E-Mail, Status-Badges
  (Owner/Admin/Gesperrt) und das Aktions-Popover (Admin-Rolle, Sperren,
  „Darf Server verbinden“). Ausgelagert aus AdminUsers.svelte, damit die Liste
  unter der Komponenten-Größen-Policy bleibt. Abzeichen und Schalter
  „Hosting“/„Selbst-Hosting erlauben“ sind 2026-10 entfallen (Spec §5).
-->
<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { anfangsBuchstabe } from '$lib/utils/anfangsBuchstabe';
  import { Popover as PopoverPrimitive } from 'bits-ui';
  import type { AdminUser } from '$lib/api/admin';
  import { safeAvatarUrl } from '$lib/avatar';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import BanIcon from '@lucide/svelte/icons/ban';
  import ServerIcon from '@lucide/svelte/icons/server';
  import CheckIcon from '@lucide/svelte/icons/check';
  import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';

  type Field = 'is_admin' | 'disabled' | 'server_verbinden_gesperrt';

  let {
    user,
    me,
    pending,
    ontoggle
  }: {
    user: AdminUser;
    me: boolean;
    pending: boolean;
    ontoggle: (u: AdminUser, field: Field, next: boolean) => void;
  } = $props();
</script>

<li class="flex items-center gap-3 p-3" data-testid="admin-user-row" data-user-id={user.id}>
  <Avatar.Root class="size-8 shrink-0">
    {#if safeAvatarUrl(user.avatar_url)}
      <Avatar.Image src={safeAvatarUrl(user.avatar_url)!} alt={user.username} />
    {/if}
    <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
      {anfangsBuchstabe(user.display_name ?? user.username)}
    </Avatar.Fallback>
  </Avatar.Root>

  <div class="min-w-0 flex-1">
    <div class="text-text-bright flex items-center gap-2 truncate text-sm font-medium">
      {user.display_name ?? user.username}
      {#if me}<span class="text-text-muted text-xs">{m.admin_users_you()}</span>{/if}
    </div>
    <div class="text-text-muted truncate text-xs">@{user.username} · {user.email}</div>
  </div>

  <div class="flex shrink-0 items-center gap-1">
    {#if user.is_owner}
      <span
        class="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400"
        data-testid="badge-owner"
      >
        {m.admin_users_badge_owner()}
      </span>
    {:else if user.is_admin}
      <span
        class="bg-primary/15 text-primary rounded-md px-2 py-0.5 text-xs font-medium"
        data-testid="badge-admin"
      >
        {m.admin_users_badge_admin()}
      </span>
    {/if}
    {#if user.disabled}
      <span
        class="rounded-md bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
        data-testid="badge-disabled"
      >
        {m.admin_users_badge_disabled()}
      </span>
    {/if}
  </div>

  <!-- Der Owner ist gegen Entmachten und Sperren geschützt, und der Riegel
       „Darf Server verbinden“ lässt sich bei ihm nicht setzen (Backend 400).
       Es bliebe kein Eintrag im Menü → für ihn gar nicht erst anbieten. Der
       Platzhalter hält die Abzeichen auf einer Linie mit den anderen Zeilen. -->
  {#if user.is_owner}
    <span class="size-8 shrink-0" aria-hidden="true"></span>
  {:else}
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="icon-sm"
            aria-label={m.admin_users_actions_aria_label()}
            disabled={pending}
            data-testid="admin-user-actions"
          >
            <MoreHorizontalIcon class="size-4" />
          </Button>
        {/snippet}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="left"
          sideOffset={8}
          class="ring-border bg-popover z-50 flex w-56 flex-col gap-1 rounded-xl p-2 shadow-xl ring-1 outline-none"
        >
          <MenuRow
            onclick={() => ontoggle(user, 'is_admin', !user.is_admin)}
            data-testid="toggle-admin-btn"
          >
            <ShieldIcon class="size-4" />
            {user.is_admin ? m.admin_users_revoke_admin() : m.admin_users_make_admin()}
          </MenuRow>
          <MenuRow
            onclick={() => ontoggle(user, 'disabled', !user.disabled)}
            data-testid="toggle-disabled-btn"
          >
            <BanIcon class="size-4" />
            {user.disabled ? m.admin_users_unban() : m.admin_users_ban()}
          </MenuRow>
          <!-- Ein Schalter, kein Paar „erlauben/entziehen“: der Haken zeigt den
               Stand (Spec E8, Skizze 2026-10-10). -->
          <MenuRow
            onclick={() =>
              ontoggle(user, 'server_verbinden_gesperrt', !user.server_verbinden_gesperrt)}
            aria-pressed={!user.server_verbinden_gesperrt}
            data-testid="toggle-verbinden-btn"
            data-erlaubt={user.server_verbinden_gesperrt ? 'nein' : 'ja'}
          >
            <ServerIcon class="size-4" />
            <span class="flex-1">{m.admin_users_darf_verbinden()}</span>
            {#if !user.server_verbinden_gesperrt}
              <CheckIcon class="size-4" />
            {/if}
          </MenuRow>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  {/if}
</li>
