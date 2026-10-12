<!--
  /verbinden#XXXX-XXXX — Bestätigung, dass ein gerade installierter Server
  diesem Konto gehören soll (Spec docs/superpowers/specs/
  2026-10-09-selfhost-ohne-freigabe-design.md, E1/E5). `pulse-connect` im
  Container zeigt Link und Code; „Ja, das ist mein Server“ trägt den Server
  auf dieses Konto ein, „Abbrechen“ lehnt den Vorgang ab (die Konsole meldet
  beides von selbst).

  Steht AUSSERHALB von /app (wie /invite/<code>): wer abgemeldet ist, soll die
  Frage sehen, statt von der Anmelde-Wache weggeschickt zu werden.

  Der Code steht hinter `#` und reist nie in einer Adresse, die der Browser
  beim Server anfordert (E5). Deshalb führt „Anmelden“ nach
  `/login?redirect=/verbinden` OHNE Code; der wartet im Speicher
  (lib/verbinden/gemerkt.ts). Registrieren endet auf /app — dort löst die
  Startseite den gemerkten Code ein (routes/app/+page.svelte).

  Bestätigen dauert in der Cloud bis ~30 s (Prüfung des Servers, Hinweis-Mails).
  Der Knopf bleibt dabei gesperrt; ein zweiter Versuch nach einem Abriss bekommt
  404, obwohl der erste gewirkt hat — das deutet `lib/verbinden/abgeschickt.ts`.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import {
    entscheideVerbindung,
    holeVerbindung,
    type VerbindenErgebnis
  } from '$lib/api/verbinden';
  import AuthBuehne from '$lib/components/AuthBuehne.svelte';
  import VerbindenKarte, { type VerbindenZustand } from '$lib/verbinden/VerbindenKarte.svelte';
  import { codeAusHash, codeNormalisieren } from '$lib/verbinden/code';
  import {
    abschickenMerken,
    abschickenVergessen,
    tabSpeicher,
    warAbgeschickt
  } from '$lib/verbinden/abgeschickt';
  import { gemerkteVerbindungEinloesen, verbindungMerken } from '$lib/verbinden/gemerkt';
  import { ausgangUngewiss, vorgangVerbraucht, type VerbindenFehler } from '$lib/verbinden/fehler';
  import { datumZeigen, fehlerDeuten, meldungstext } from '$lib/verbinden/anzeige';
  import { browserSpeicher } from '$lib/einladung/gemerkt';
  import { m } from '$lib/paraglide/messages.js';

  const ausAdresse = $derived(codeAusHash(page.url.hash));
  const konto = $derived(auth.user?.username ?? '');

  let zustand = $state<VerbindenZustand>('laden');
  let code = $state<string | null>(null);
  let hostname = $state<string | null>(null);
  let adresseVergeben = $state(false);
  let fristBis = $state('');
  let hinweis = $state<string | null>(null);
  let fehlerArt = $state<string | null>(null);
  // Welche Entscheidung gerade unterwegs ist; `null` = keine. Sperrt beide Knöpfe
  // und lässt die Frage nur beim Bestätigen von der langen Prüfung sprechen.
  let aktion = $state<'verbinden' | 'ablehnen' | null>(null);
  // Gegen überholte Antworten, wenn der Code wechselt (Eingabe, neuer Link) —
  // beim Laden wie beim Bestätigen.
  let lauf = 0;

  function hinweisSetzen(art: string | null, text: string | null): void {
    fehlerArt = art;
    hinweis = text;
  }

  /** Zeigt einen gedeuteten Fehler (`beimBestaetigen`: s. `meldungstext`). */
  function fehlerZeigen(f: VerbindenFehler, beimBestaetigen: boolean): void {
    if (f.art === 'uebernahme_gesperrt') {
      // Ein Endzustand: die Cloud hat den Vorgang beendet, es gibt nichts mehr zu bestätigen.
      fristBis = datumZeigen(f.bis);
      zustand = 'uebernahme_gesperrt';
      return;
    }
    if (f.art === 'unbekannt' || f.art === 'nachsehen' || f.art === 'abgemeldet') {
      zustand = f.art;
      return;
    }
    hinweisSetzen(f.art, meldungstext(f, beimBestaetigen));
    // Beim Bestätigen bleibt die Frage stehen: nach einem behobenen Proxy oder
    // einem gelöschten Server genügt ein zweiter Klick. Beim Laden gibt es
    // noch nichts zu bestätigen.
    if (zustand !== 'bereit') zustand = 'fehler';
  }

  async function laden(ausDerAdresse: string | null): Promise<void> {
    const meiner = ++lauf;
    zustand = 'laden';
    hostname = null;
    adresseVergeben = false;
    fristBis = '';
    aktion = null;
    hinweisSetzen(null, null);
    // Auth wird nur im /app-Layout hydriert; diese Route liegt außerhalb.
    await auth.hydrate().catch(() => {});
    if (meiner !== lauf) return;
    if (auth.user) {
      // Ein gemerkter Code gehört dieser Seite, sobald sie angemeldet ist — auch
      // wenn die Adresse einen eigenen trägt: bliebe er stehen, holte /app ihn
      // später auf einen alten Code zurück.
      const gemerkt = gemerkteVerbindungEinloesen(browserSpeicher(), Date.now());
      if (!ausDerAdresse && gemerkt) {
        // Rückweg über die Anmeldung: den Code in die Adresse setzen, damit ein
        // Neuladen ihn behält (wie der Rückweg über /app); der Lade-Effekt macht
        // von dort weiter.
        void goto(`/verbinden#${gemerkt}`, { replaceState: true, noScroll: true, keepFocus: true });
        return;
      }
    }
    const c = ausDerAdresse;
    code = c;
    if (!c) {
      zustand = 'eingabe';
      return;
    }
    if (!auth.user) {
      zustand = 'abgemeldet';
      return;
    }
    try {
      const v = await holeVerbindung(c);
      if (meiner !== lauf) return;
      hostname = v.hostname;
      adresseVergeben = v.adresse_vergeben === true;
      zustand = 'bereit';
    } catch (err) {
      if (meiner !== lauf) return;
      fehlerZeigen(fehlerDeuten(err, warAbgeschickt(tabSpeicher(), c, Date.now())), false);
    }
  }

  $effect(() => {
    const c = ausAdresse;
    untrack(() => void laden(c));
  });

  function codeEingegeben(roh: string): void {
    const c = codeNormalisieren(roh);
    if (!c) {
      hinweisSetzen('eingabe', m.verbinden_eingabe_ungueltig());
      return;
    }
    // Über die Adresse statt direkt laden: ein Neuladen behält den Code, und
    // ein Wechsel hinter `#` bleibt im Browser.
    void goto(`/verbinden#${c}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function merkenUndWeiter(ziel: string): void {
    if (code) verbindungMerken(browserSpeicher(), code, Date.now());
    void goto(ziel);
  }

  function ergebnisZeigen(r: VerbindenErgebnis): void {
    if (r.status === 'verbunden') {
      zustand = 'verbunden';
      leisteSpaeterAbgleichen();
    } else if (r.status === 'uebernahme_beantragt') {
      fristBis = datumZeigen(r.frist_bis);
      zustand = 'uebernahme_beantragt';
    } else if (r.status === 'abgelehnt') {
      zustand = 'abgelehnt';
    } else {
      // Eine Antwort, die diese Seite nicht kennt: nichts behaupten.
      fehlerZeigen({ art: 'sonst' }, true);
    }
  }

  async function entscheiden(wahl: 'verbinden' | 'ablehnen'): Promise<void> {
    const c = code;
    if (!c || aktion) return;
    const meiner = lauf;
    aktion = wahl;
    hinweisSetzen(null, null);
    // Die Marke VOR dem Senden: reißt die Verbindung ab, hat die Cloud die
    // Entscheidung vielleicht trotzdem angenommen. `frueher` fragt nach einem
    // früheren Versuch, nicht nach diesem.
    const speicher = tabSpeicher();
    const frueher = warAbgeschickt(speicher, c, Date.now());
    abschickenMerken(speicher, c, Date.now());
    try {
      const r = await entscheideVerbindung(c, wahl);
      if (meiner === lauf) ergebnisZeigen(r);
    } catch (err) {
      // Ein Ergebnis für einen inzwischen gewechselten Code gehört nicht mehr
      // auf diese Seite.
      if (meiner !== lauf) return;
      const f = fehlerDeuten(err, frueher);
      // Eine ausdrückliche Antwort der Cloud heißt: es ist nichts geschehen —
      // außer wenn sie den Vorgang beendet hat (dann bleibt die Marke).
      if (!ausgangUngewiss(f) && !vorgangVerbraucht(f)) abschickenVergessen(speicher);
      fehlerZeigen(f, true);
    } finally {
      // Hat `laden` inzwischen einen neuen Code aufgenommen, hat es `aktion` schon zurückgesetzt.
      if (meiner === lauf) aktion = null;
    }
  }

  /** Der neue Server zählt für die Leiste erst als eingerichtet, wenn
   *  `pulse-connect` die Zugangsdaten abgeholt hat (Spec E3) — das geschieht im
   *  Abfrage-Abstand der Konsole (5 s) NACH diesem Klick; ein Abgleich jetzt
   *  sähe ihn noch nicht. Andere Geräte holt das Ereignis `instanz_verbunden`
   *  (handlers/instanzen.ts); dieser Tab hat keine WebSocket, die Seite liegt
   *  außerhalb von /app. Einmalig und ohne Abbau beim Verlassen: der Store ist
   *  app-weit, und wer sofort „Zu Pulse“ klickt, soll den Server trotzdem
   *  bekommen. */
  function leisteSpaeterAbgleichen(): void {
    setTimeout(() => void serversStore.hydrateFromBackend(), 8000);
  }
</script>

<svelte:head>
  <title>{m.verbinden_seitentitel()}</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
  <AuthBuehne />
  <VerbindenKarte
    {zustand}
    {code}
    {hostname}
    {konto}
    {adresseVergeben}
    {fristBis}
    {hinweis}
    {fehlerArt}
    {aktion}
    onCode={codeEingegeben}
    onAnmelden={() => merkenUndWeiter('/login?redirect=%2Fverbinden')}
    onRegistrieren={() => merkenUndWeiter('/register')}
    onVerbinden={() => entscheiden('verbinden')}
    onAbbrechen={() => entscheiden('ablehnen')}
    onErneut={() => laden(code)}
    onZuPulse={() => goto('/app')}
  />
</div>
