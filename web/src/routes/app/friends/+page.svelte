<!--
  /app/friends — tabbed view over friends, pending requests, blocked
  users and "add friend". Tab is mirrored to the ?tab=… search param
  so deep-links and back/forward navigation hold. Default tab: online.

  Renders inside the existing app shell (GuildRail + DMChannelList).
  The DM list stays mounted so the user can still hop between DMs from
  here — same UX as Discord's "Friends" page.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { eintrittsKlasse } from '$lib/navigation/richtung';
  import { page } from '$app/state';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import DMChannelList from '$lib/components/DMChannelList.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { selectGuild, selectDM } from '$lib/navigation/railNavi';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
  import { friends } from '$lib/stores/friends.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import FriendList from '$lib/components/friends/FriendList.svelte';
  import PendingRequests from '$lib/components/friends/PendingRequests.svelte';
  import BlockedList from '$lib/components/friends/BlockedList.svelte';
  import FriendsKopfAktionen from '$lib/components/friends/FriendsKopfAktionen.svelte';
  import AddFriendPanel from '$lib/components/friends/AddFriendPanel.svelte';
  import BereichsKopf from '$lib/components/mobile/BereichsKopf.svelte';
  import SuchPille from '$lib/components/SuchPille.svelte';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import ClockIcon from '@lucide/svelte/icons/clock';
  import BanIcon from '@lucide/svelte/icons/ban';
  import KopfMenue from '$lib/components/mobile/KopfMenue.svelte';
  import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
  import { m } from '$lib/paraglide/messages.js';

  // Suche über die Freundesliste — nur Namen, keine Nachrichten/Kanäle; das
  // Filtern (ab 3 Zeichen, sonderzeichen-frei) macht FriendList selbst.
  /** Eintritts-Animation je nach Richtung (`navigation/richtung.ts`). */
  const eintritt = eintrittsKlasse('wurzel');
  let freundeSuche = $state('');

  /** Anfragen-Zahl fürs Menü-Badge — NUR eingehende Freundschaftsanfragen.
   *
   *  Bis 2026-08-27 zählte sie die Community-Einladungen mit. Die sind mit dem
   *  Umbau nach `/app/invites` gezogen; die Zahl blieb stehen und behauptete
   *  seither etwas, das hinter „Ausstehend" gar nicht zu finden war — vier
   *  Einladungen liessen den Reiter melden, dort lägen vier Anfragen, und wer
   *  hinsah, fand nichts. Ein Zähler darf nur zählen, was hinter ihm liegt. */
  const pendingBadge = $derived(friendRequests.incomingList.length);

  /** Titel der Unteransicht — steht neben dem Zurück-Pfeil. */
  function untertitel(): string {
    if (activeTab === 'pending') return m.friends_tab_pending();
    if (activeTab === 'blocked') return m.friends_tab_blocked();
    return m.friends_tab_add();
  }

  // 'online' ist 2026-08-27 entfallen: die Seite hat `onlineOnly` nie an
  // FriendList durchgereicht, der Reiter zeigte also dasselbe wie 'all'.
  // FriendList gruppiert ohnehin selbst in Online- und Offline-Block.
  type TabKey = 'all' | 'pending' | 'blocked' | 'add';
  const TABS: { key: TabKey; label: () => string }[] = [
    { key: 'all', label: () => m.friends_tab_all() },
    { key: 'add', label: () => m.friends_tab_add() },
    { key: 'pending', label: () => m.friends_tab_pending() },
    { key: 'blocked', label: () => m.friends_tab_blocked() }
  ];

  const activeTab = $derived<TabKey>(
    (TABS.find((t) => t.key === page.url.searchParams.get('tab'))?.key) ?? 'all'
  );

  // DEV-ONLY: ?demo=online markiert alle vorhandenen Freunde rotierend als
  // online/idle/dnd — für Layout-Tests der Freundesliste ohne echte Peers.
  // Läuft als Effect (statt einmalig beim Mount), damit auch nachträglich
  // geladene Freunde erfasst werden; ein echter Cloud-Seed gewinnt jederzeit.
  if (import.meta.env.DEV) {
    $effect(() => {
      if (page.url.searchParams.get('demo') !== 'online') return;
      const ids = friends.list.map((f) => f.user_id);
      presence.devSimulateFriendsOnline(ids);
    });
  }

  // Seltenes (Hinzufügen, Anfragen, Blockiert) steckt hinter dem Kopf-Knopf; die
  // Anfragen-Zahl wandert als Plakette mit.
  const kopfAktionen = $derived<ZeilenAktion[]>([
    {
      id: 'add',
      label: m.friends_tab_add(),
      icon: UserPlusIcon,
      onSelect: () => void switchTab('add'),
      testid: 'friends-menu-add'
    },
    {
      id: 'pending',
      label: m.friends_tab_pending(),
      icon: ClockIcon,
      onSelect: () => void switchTab('pending'),
      testid: 'friends-menu-pending',
      zahl: pendingBadge,
      zahlTestid: 'pending-badge'
    },
    {
      id: 'blocked',
      label: m.friends_tab_blocked(),
      icon: BanIcon,
      onSelect: () => void switchTab('blocked'),
      testid: 'friends-menu-blocked'
    }
  ]);

  async function switchTab(key: TabKey) {
    const url = new URL(page.url);
    url.searchParams.set('tab', key);
    await goto(url.pathname + url.search, { replaceState: true, keepFocus: true });
  }
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={currentServerUserId()}
  homeActive={true}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
  onHomeClick={() => goto('/app/friends')}
/>

<!-- Die DM-Spalte gehoert ab `md` neben die Freunde; auf dem Handy sind
     private Gespraeche ein eigener Bereich (Chats), eine zweite Liste hier
     waere derselbe Inhalt an zwei Orten. -->
{#if !viewport.isMobile}
  <DMChannelList
    activeDMId={null}
    onSelect={selectDM}
    handy={false}
    serverKnopf={viewport.isDesktop}
  />
{/if}

<section
  class="glass-panel {eintritt} flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none nicht-handy:rounded-2xl"
  data-testid="friends-page"
>
  <BereichsKopf titel={m.friends_page_title()}>
    {#snippet handlung()}
      <!-- Drei-Punkte statt Reiter-Leiste (wie beim Chats-Bereich): die
           Liste gehört dem Inhalt, Seltenes (Hinzufügen, Anfragen, Blockiert)
           steckt im Menü. Die Anfragen-Zahl wandert als Badge mit. -->
      <FriendsKopfAktionen {activeTab} {pendingBadge} onSwitch={switchTab} />
      <div class="nicht-handy:hidden">
        <KopfMenue wort={m.menue_mehr()} icon={EllipsisIcon} aktionen={kopfAktionen} testid="friends-menu" />
      </div>
    {/snippet}
  </BereichsKopf>
  <!-- Suchleiste außerhalb des Scroll-Bereichs, in derselben Hülle wie die
       der Chats (px-5 pb-5, gleiche Label-Klassen): gleiche Größe, gleiche
       Höhe — zwei Bereiche, dieselbe Frage „wo suche ich\" sollen sich
       nicht durch Versatz verraten. -->
  {#if activeTab !== 'pending' && activeTab !== 'blocked' && activeTab !== 'add'}
    <SuchPille bind:value={freundeSuche} placeholder={m.friends_search_placeholder()} testid="friends" />
  {/if}
  <div class="flex-1 overflow-y-auto px-4 pb-4">
    {#if activeTab === 'pending' || activeTab === 'blocked' || activeTab === 'add'}
      <!-- Unteransicht mit Zurück-Zeile statt Reiter: die Menü-Punkte sind
           Ausnahmefälle, kein parallel sichtbarer Zustand. -->
      <button
        type="button"
        class="text-text-muted hover:text-text-bright mb-3 flex items-center gap-1 pt-4 text-sm font-semibold nicht-handy:hidden"
        onclick={() => switchTab('all')}
        data-testid="friends-back"
      >
        <ChevronLeftIcon class="size-5" />
        {untertitel()}
      </button>
      {#if activeTab === 'pending'}
        <PendingRequests />
      {:else if activeTab === 'blocked'}
        <BlockedList />
      {:else}
        <AddFriendPanel />
      {/if}
    {:else}
      <FriendList suche={freundeSuche} handy={viewport.isMobile} />
    {/if}
  </div>
</section>
