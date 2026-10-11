# iOS-Bughunt 2 — 2026-10-11

Branch `feat/ios`, Stand `692fc5d7`, geprüft gegen die Merge-Basis mit `main`
(`c0284d33`): 144 Commits, 329 Dateien. Nur gesucht und belegt, nichts behoben.

**Vorgehen.** Sechs Prüfer, je ein Risikobereich, nur lesend (A Anrufe, B
nativer Sprachraum und Brücke, C Push/Plakette/Lesestand, D Erweiterungen und
System, E CI/Skripte/Infra, F übrige Hülle). Jeder Fund ab „mittel" ging an
einen zweiten, frischen Prüfer mit dem Auftrag, ihn zu **widerlegen**; die
kritischen hat die Hauptsitzung zusätzlich selbst am Code nachgesehen.
Bekannt aus [Bughunt 1](2026-10-11-ios-bughunt.md) und die dokumentierten
Produktgrenzen wurden nicht erneut gemeldet.

**Stand** je Fund: *bestätigt* = Code-Pfad samt Aufrufern von zwei Prüfern
unabhängig nachvollzogen; *plausibel* = Pfad steht, die Wirkung hängt an
Laufzeit oder Gerät. Die Schwere ist die nach der Gegenprüfung.

Ergebnis: 42 Rohfunde plus ein Nebenbefund der Gegenprüfung (N1) → 3 hoch,
17 mittel (D2 ist in B1 aufgegangen), 15 niedrig, 2 widerlegt, 5 nicht
entschieden.

---

## Hoch

### N1 — Neuladen auf der Sprachkanal-Seite: iOS tritt neu bei statt zu übernehmen, mit offenem Mikrofon
`web/src/routes/app/+layout.svelte:291` · `voice/livekit.svelte.ts` (`resumeVoiceIfPending`) · Kanal-Route `+page.svelte:122-131` · `voice/nativerRaum.svelte.ts:142-160` · `SpracheRaum.swift:152`

`hydrated = true` gibt die Route frei; `resumeVoiceIfPending` prüft
`connected/connecting` **vor** dem `await voice.nativUebernehmen(r)` (ein
Brücken-Rundlauf) und setzt in der Zwischenzeit nichts. Der Auto-Beitritt der
Kanal-Route (nur Handy) sieht `!connected && !connecting` und ruft
`voice.connect(ch)` ohne Optionen → nativer Beitritt → die Hülle verlässt den
überlebenden Raum und tritt **mit offenem Mikrofon, nicht taub** neu bei.
Stumm/taub von vorher sind weg. Trifft jedes Neuladen (WebContent-Absturz,
„Neu laden" nach Update) auf der Sprachkanal-Route am iPhone. Auf `main`
harmlos: dort setzte der Resume-`connect` sofort `Connecting`.
**Stand:** Nebenbefund der Gegenprüfung B/D, von der Hauptsitzung am Code
bestätigt (Reihenfolge der Mikrotasks gefolgert, nicht ausgeführt).
**Fix-Richtung:** den Connecting-Riegel vor dem `await` setzen, oder
`uebernehmen` entwertet laufende `connect`-Versuche und die Route wartet auf
den Abgleich.

### F1 — App-Sperre (Face ID) ist durchsichtig, die App darunter lesbar
`components/AppSperre.svelte:36` · `app.css:73` · `routes/app/+layout.svelte:657`

`bg-bg-base` ist `--color-bg-base: transparent` (einzige Definition). Die
Shell darunter trägt bewusst keinen Hintergrund, der Seitengrund liegt auf
z-index −1/−2 — unter der Sperre (z-60) ist DM-Liste, nach Tiefenlink oder
Mitteilung der offene Chat im Klartext lesbar. Zusätzlich liegen Lightbox
(Portal, z-60, später im DOM) und Toasts (z-index 999999999) **über** der
Sperre, und die Shell ist nicht `inert` (iPad mit Tastatur: Tab erreicht
Elemente darunter, vermutet). **Stand:** bestätigt (Hauptsitzung + Gegenprüfung).
**Fix-Richtung:** deckende Farbe, über Toasts und Portale heben, Shell `inert`
(Muster `remote/sichtschutz.ts::restlicheAppSperren`). Gleiche Wurzel wie F4/F5.

### E1 — Produktion und Self-Host fahren pulse8 ohne `PULSE_KEYFRAME_ON_JOIN`
`infra/prod/docker-compose.yml:422ff` · `infra/self-host/s6/…/mediamtx/run:15-18` · Patch `0008-vollbild-beim-beitritt` (`== "1"`, Vorgabe aus)

Der Branch hebt Prod und das allinone-Image auf `1.19.1-pulse8`, setzt den
Schalter aber nur in Dev, macOS und auf dem Hetzner-Stack. In Produktion tut
Patch 0008 nichts — ein iPhone-Zuschauer ohne Chromium im Raum sieht weiter bis
zu 60 s Schwarz. Die Begründung in `049a9c35` („Bild muss erst nach GHCR")
trägt nicht: einen Pull braucht der Tag-Wechsel, ein unbekannter Schalter wäre
auf jedem Bild wirkungslos. `CLAUDE.md` beschreibt die Variable als aktiv.
Keine Regression, aber die Behebung erreicht Prod nicht. **Stand:** bestätigt.
**Fix-Richtung:** Schalter in beiden Dateien ergänzen.

---

## Mittel

### Anrufe

**A2 — Erster Anruf nach der Installation: Mikrofon tot, Oberfläche zeigt es offen.**
`AnrufSitzung.swift:66-78`, `AnrufRaum.swift:136`. Die Erlaubnis wird nur in
`didActivate` gelesen; `mikrofonErlaubnisHolen` läuft erst danach im Beitritt.
Nach „Erlauben" gibt niemand die Eingabe der Audio-Maschine frei (SDK-Doc
`AudioManager.swift:475-495`), `zustand().mikro` meldet trotzdem `true`. Die
Gegenseite hört nichts, ein Gespräch lang. Bestätigt; einmal je Installation.
*Fix:* nach der Erlaubnis `.default` setzen, wenn CallKit die Session hält.

**A3 — Annahme auf dem Sperrbildschirm bei eingefrorener WebView: stilles Gespräch ohne Frist.**
`AnrufCallKit.swift:39-49`, `AnrufPushAusgang.swift:79-80, 110`. Die Annahme
erreicht den Server nur über das Web. Bleibt es eingefroren, endet der Anruf am
Server als „verpasst", und der Abbruch-Push wird für die Phase `.angenommen`
verworfen. CallKit zeigt ein laufendes Gespräch in Stille, der Kanal bleibt
angehalten. Plausibel (das Einfrieren ist ungemessen). *Fix:* Abbruch für
`.angenommen` beenden, wenn der Anruf-Raum für diese Kennung nie entstand.

**A4 — Annahme vom Ende überholt: verwaister Halter und Phantom-Gespräch.**
`anruf.svelte.ts:145-166`, `nativerAnrufRaum.ts:45-55`, `AnrufCallKit.swift:102-104, 139`.
`annehmen()` prüft nach `await anrufAnnehmen()` nicht, ob inzwischen abgebaut
wurde: WebKit bleibt bis zum Reload auf `ambient`, die Hülle beginnt per
`CXStartCallAction` ein Gespräch, das nichts beendet. Bestätigt (Rennen,
selten). *Fix:* `this.aktiv?.id === anruf.id` prüfen; `gespraechBeginnen`
weist `kuerzlichBeendet` ab.

**A5 — Anklopfen während eines nativen Gesprächs ist kaputt.**
`anruf.svelte.ts:124-127`, `api/anrufe.ts:37-38`, `Anrufverwaltung.swift:182`, `anrufHuelle.ts:128-141`.
Das Web lehnt den zweiten Anruf mit `geraet_id` ab (also kein Abbruch an sich
selbst), der Push meldet ihn trotzdem; „Beenden & Annehmen" schliesst über
`beenden(kennung: nil)` auch B, die Annahme von B fällt im Web still durch.
Regression durch T14. Bestätigt. *Fix:* den Auto-Abgelehnten an die Hülle
melden oder ohne `geraet_id` ablehnen.

**A6 — Jeder fremd beendete Klingel-Anruf blitzt im Vordergrund als zweiter Anruf auf.**
`routes/anrufe.py:160-168` (erst `_publish`, dann Abbruch im Hintergrund),
`AnrufPushAusgang.swift:82-83`. Bei wacher App kommt das WS-Ende vor dem
Abbruch-Push; die Hülle kennt den Anruf dann nicht mehr und meldet
regelkonform mit Wegwerf-UUID „Pulse" und beendet sofort — kurzer zweiter
Anrufbildschirm, Eintrag im Anrufverlauf (`includesCallsInRecents` Vorgabe).
Normalfall jedes nicht angenommenen Anrufs im Vordergrund. Bestätigt (Sichtbarkeit
nur am Gerät). Auf Hüllen **vor `9184816d`** ist derselbe Ablauf ein echter
Verstoss gegen PushKit (Rest von K3, s. A1). *Fix:* den CallKit-Eintrag nach dem
WS-Ende kurz offen halten, bis der Abbruch kommt, oder serverseitig an Geräte
sparen, die das Ende quittiert haben.

**A7 — Spätes `didDeactivate` sperrt die Audio-Maschine des Kanals.**
`AnrufSitzung.swift:83-87, 107-121`. `.none` wird bei jedem `didDeactivate`
gesetzt, auch nach der Rückgabe ans SDK (3-s-Notbremse, Ende vor
`didActivate`, `providerDidReset`) — der native Kanal bleibt bis zum nächsten
Anruf taub und stumm. Plausibel (Zeitfolgen nur am Gerät). *Fix:* `.none` nur,
solange `callkitAktiv`.

### Nativer Sprachraum

**B1 — Auflegen ohne Web-Hörer: der nächste Start tritt demselben Kanal wieder bei** (enthält D2).
`SprachePlugin.swift:37-53` (`retainUntilConsumed: NO`), `SpracheSteuerleiste.swift:212-244`,
`SpracheLiveAktivitaet.swift:298-302`, `nativAbgleich.ts:68`, Capacitor
`WebViewDelegationHandler.swift:164-168`. Nach einem WebContent-Absturz sind
alle Hörer weg; „Auflegen" in Ansicht oder Live Activity legt die Hülle selbst
auf, das `disconnected` geht verloren. Beim Neustart sagt der Abgleich
„nichts", `resumeVoiceIfPending` tritt mit dem Eintrag wieder bei — und
**zusätzlich** (D2) steht die Adresse noch auf der Sprachkanal-Route, deren
Auto-Beitritt (D1/N1) auch ohne Eintrag wieder beitritt. Bestätigt;
`sessionStorage` über den Absturz hinweg ist ungemessen (E5 aus Bughunt 1
setzt dasselbe voraus). *Fix:* Hülle merkt „Sitzung N aufgelegt" und meldet es
in `zustand()`; Abgleich verwirft den Eintrag, die Route fragt denselben Riegel.

**B2 — Verlassen und schneller Neubeitritt: das späte Teardown räumt den neuen Beitritt ab.**
`nativerRaum.svelte.ts:165-175`, `livekit.svelte.ts:430-470, 811-814, 1999`.
`aktiv=false` vor dem `await spracheVerlassen()` → `connect` sieht den Abbau
nicht. Häufig: der Tipp tut still nichts. Selten (langsames `disconnect`): ein
unsichtbarer Raum mit offenem Mikrofon. Nur direkte `voice.connect`-Aufrufe
(ChannelList, Kanal-Route) öffnen das Fenster. Bestätigt. *Fix:* `connect`
wartet auf ein laufendes natives Verlassen, oder `#teardown` räumt nur die
eigene Generation.

### Push, Plakette, Lesestand

**C1 — Kurz nach dem Wegstecken bleibt eine DM ohne Mitteilung.**
`fcm.py:245`, `pubsub.py:161, 948`. Der DM-Push geht nur an Konten ohne
„frischen" Socket (95 s); ein eben gesperrtes iPhone gilt so lange als online.
Die Mitteilung ist dann endgültig verloren. Für Anrufe ist das geheilt (T14),
für DMs nicht; auf `main` war die Lücke unbegrenzt. Bestätigt. *Fix:* iOS
immer pushen, im Vordergrund nativ unterdrücken.

**C2 — Tote oder widerrufene Sitzung: Push- und VoIP-Token bleiben registriert.**
`stores/auth.svelte.ts:411-414`, `cookie-client.ts:89-95`, `gateway-connection.ts:432-438`,
`routes/_geraetetoken.py:99-110`. Auf dem Weg „Sitzung tot" sind die Tokens
schon gelöscht, bevor `signOut` die Abmeldung versucht — das DELETE scheitert
still. Serverseitig löscht ein Widerruf die Zeilen nie. Ein verlorenes Telefon
zeigt weiter Banner mit Absender und klingelt mit Anrufername. Bestätigt (der
Teil „normales Abmelden nach 15 min" ist widerlegt: die WS erneuert das Token).
*Fix:* Tokens an die Anmelde-Kette binden und beim Widerruf mitlöschen.

**C4 — Ablage-Kanal löst DM-Push und Plakette aus; Tippen und „Antworten" laufen ins Leere.**
`routes/postfach.py:350, 399`, `_postfach_deps.py:117-141`, `krypto/gruppe/kanalSenden.ts:232`.
Jede Ablage-Nachricht zählt die Plakette hoch und meldet „Neue
Direktnachricht"; der Tipp öffnet `/app/@me/<Gildenkanal>` („DM nicht
gefunden"), eine Banner-Antwort bleibt liegen. Fehlnavigation gab es auf
`main` schon (Android), Plakette und verlorene Antwort sind neu. Bestätigt.
*Fix:* Push nur für DM/private Gruppe, `zeigAn` nach Kanalart routen.

### Erweiterungen und System

**D1 — Ein fremder Universal Link auf einen Sprachkanal tritt ungefragt bei, mit offenem Mikrofon.**
`platform/tiefenlink.ts:37`, `universalLinks.ts:23-30`, AASA `/app/guilds/*`,
Kanal-Route `+page.svelte:122-131`, `livekit.svelte.ts:509-513`. Neu durch die
Universal Links: ein Link per iMessage/QR öffnet die Route, die am Handy sofort
und unstumm beitritt (sichtbar: Ansicht, Beitrittston). Bestätigt. *Fix:*
Auto-Beitritt nur bei einem Tipp in der App; ein Ziel von aussen landet ohne
Beitritt oder stumm.

### Übrige Hülle

**F4 + F5 — Die App-Sperre hält nichts an, sie ist nur Optik.**
F4: `+layout.svelte:298` → `autoconnect.svelte.ts:113` (`startMuted: false`) —
Kaltstart mit Sperre und Auto-Beitritt: offenes Mikrofon im Kanal vor Face ID.
F5: `@me/+page.svelte:224-233` — eine Banner-Antwort wird bei gesperrter App
gesendet. Beide bestätigt, gleiche Wurzel wie F1. *Fix:* Start-Aktionen mit
Aussenwirkung (Resume, Auto-Beitritt, Banner-Antwort) hinter die Entsperrung.

**F2 — Android: Download unverschlüsselter Anhänge tut nichts mehr (Regression).**
`platform/dateiTeilen.ts:54-85`, `MainActivity.java:82`. Statt des https-Ankers
(DownloadManager) wird ein Blob geholt; ohne `navigator.canShare` (Android-WebView)
fällt es auf `<a href=blob:>`, das MainActivity ausdrücklich verwirft. Betrifft
jeden ausgelieferten Android-Bau, sobald das Web deployt ist. Bestätigt (WebView-Stand
aus Doku). *Fix:* auf Android für Klartext-URLs den alten Anker behalten.

**F3 — „Später" vor der Mitteilungsfrage sperrt Mitteilungen auf iOS für immer.**
`platform/berechtigung.svelte.ts:127`, `berechtigungRegel.ts:111`, einziger
Aufrufer `MessageInput.svelte:445`. Ohne je gefragt zu haben, führt iOS die App
nicht unter Einstellungen → Mitteilungen; kein zweiter Weg zum Dialog.
Bestätigt (iOS-Verhalten nicht gemessen). *Fix:* „Später" befristen, Schalter
in den App-Einstellungen.

### Infra und Lizenz

**E3 — Eingebettete iOS-Frameworks ohne Lizenzhinweise.**
`THIRD-PARTY-NOTICES.md`, `web/src/lib/legal/drittanbieter.md`. LiveKit Swift
(Apache-2.0 mit `NOTICE`), WebRTC (BSD-3) und livekit-uniffi (Apache-2.0)
werden als Frameworks ausgeliefert und stehen nirgends; dieselbe Lücke haben
Firebase-iOS und Capacitor (schon vor dem Branch). Greift mit der ersten
Weitergabe (TestFlight). Bestätigt. *Fix:* Mobil-Abschnitt in beiden Dateien.

---

## Niedrig (bestätigt oder plausibel, einfach gegengeprüft)

| Kennung | Kurz | Ort |
|---|---|---|
| A8 | Lautsprecher-Stand überlebt das Gespräch, der nächste Anruf beginnt laut | `AnrufRaum.swift:54` |
| A9 | Kalt gestartete Annahme spielt den DM-Ton ins laufende Gespräch (plausibel) | `anrufHuelle.ts:116-127` |
| A10 | Reload vor dem Raum: ein Anruf ohne Raum ist nicht übernehmbar | `anrufHuelle.ts:80` |
| B3 | Anruf-Pause wird im Web zu echtem Taub/Stumm und wandert in einen Kanalwechsel | `SpracheRaumZustand.swift:190` |
| B5 | G4-Fix unvollständig: Reihenfolge entsteht erst im `Task` | `SprachePlugin.swift:60-71` |
| B6 | `notifyListeners` von LiveKit-Fäden gegen unsynchronisierte Hörer-Tabelle (plausibel) | `CAPPlugin.m:41-131` |
| C3 | Badge-Drossel verwirft statt nachzumelden — Zahl vorübergehend falsch | `badgeMelden.ts:38` |
| C6 | T10-Rückfall als Entwurf im offenen Gespräch unsichtbar | `@me/+page.svelte:230` |
| C7 | Icon wird vor dem Laden auf 0 geräumt (offline bleibt es 0) | `+layout.svelte:457` |
| D4 | Live Activity ohne `staleDate`: nach Absturz bis 8–12 h „verbunden" | `SpracheLiveAktivitaet.swift:110` |
| D5 | Beginnt die Live Activity im Hintergrund nicht, kommt sie nie | `SpracheLiveAktivitaet.swift:107-123` |
| E2 | Playwright-Uploads: Presign `localhost` ≠ Proxy-Host → 403 (nur E2E/Dev) | `vite.config.ts:253`, `_globalSetup.ts` |
| E4 | `voiceover-namen.sh` unter Windows rot (Kodierung, plausibel) | `scripts/voiceover-namen.sh:43` |
| E5 | `dev-up.fish` nimmt die macOS-Compose-Aufsätze bei jedem Lauf zurück | `scripts/dev-up.fish:96, 153` |
| F8 | Bewertungsfrage wird von einem alten Bau ohne Plugin verbraucht | `bewertung.ts:70-72` |

## Widerlegt

- **A1** „Ältere Bauten werden bei jedem Anruf mit offener App beendet": Apple
  DTS (Forum-Thread 117939): *„While your app currently has an active call
  (ringing or answered), your app is not required to create additional calls
  for VoIP pushes received during this call."* Ein alter Bau kennt den Anruf
  nur, solange er bei CallKit aktiv ist — kein Verstoss. Der echte Restfall
  (Abbruch-Push nach WS-Ende auf Hüllen vor `9184816d`) steht bei A6.
  `a1880c1c` (erneut melden mit derselben UUID) bleibt richtig, ist aber
  Absicherung, nicht Pflicht.
- **C5** „Banner-Antwort doppelt": beide Hörer legen unter demselben Schlüssel
  ab, der Effekt nimmt genau einmal.

## Nicht entschieden

- **B4** — nach Reload bis zur Übernahme kein `ambient`/kein Mikrofon-Riegel (nicht gegengeprüft).
- **D3** — Teilen-Erweiterung ohne Abbruch und Frist beim Laden (nicht gegengeprüft).
- **F6** — Weckprüfung schliesst eine tote Verbindung, wählt aber nicht neu (hängt an WebKits CLOSING-Dauer).
- **F7** — Vorerklärung überlebt die abgebaute Kamera-Ansicht (Android, Abbau-Reihenfolge).
- **E6** — pulse8-Tag und Patch im selben Commit: das Bild läuft seit zwei Tagen
  auf dem Hetzner-Stack unter dem GHCR-Namen, der Fund ist damit sehr
  wahrscheinlich gegenstandslos; GHCR selbst nicht abgefragt.

## Nur am Gerät zu klären

A2 (Gegenseite hört nichts), A3 (WebView eingefroren nach Annahme), A5
(Anklopfen bei `maximumCallGroups = 1`), A6 (Aufblitzen, Verlaufseintrag), A7
(Zeitpunkt `didDeactivate`), B1/D2 (`sessionStorage` nach WebContent-Absturz),
C1 (halboffener Socket), F3 (iOS-Einstellungen ohne Anfrage).

---

## Stand der Behebung (2026-10-11)

Alle bestätigten und plausiblen Funde sowie die fünf nicht entschiedenen sind
behoben, in drei Runden je von einem frischen Agenten, jede im Prüfbaum
nachgeprüft (Typprüfung, Unit-Tests, Simulator-Bau, Backend-Suiten) und auf
den Dev-Stack ausgeliefert:

| Runde | Commits | Funde |
|---|---|---|
| 1 | `2246c52c..4deea71d` | N1, D1, B1/D2, F1, F4, F5, E1 |
| 2 | `7b811921..7a7a6864` | A2–A10, B2–B6, D4, D5 |
| 3 | `a0a867ec..2865023f` | C1–C4, C6, C7, D3, E2–E5, F2, F3, F6–F8, dazu die Nachzügler aus Runde 2 (Sendable-Warnungen, `notifyListeners` in drei weiteren Plugins, Knöpfe der nativen Ansicht in die Befehlskette) |

**Nur am Gerät belegbar** bleibt, was oben unter „Nur am Gerät zu klären"
steht, dazu: dass die Gegenseite im ersten Anruf hört (A2), der Vordergrund-
Riegel für DM-Banner (C1), der Android-Download (F2).

**Offen geblieben:** verschlüsselte Anhänge unter Android (der Klartext liegt
nur als `blob:` vor, die Hülle verwirft das — vor dem Branch schon so);
`MainActivity` speichert Downloads ohne Dateinamen; ein `auth:ketten_ende`
während eines Gateway-Neustarts geht verloren, eine still abgelaufene Kette
meldet niemand; WebRTC-Unterbibliotheken, Rust-Crates in livekit-uniffi und
die Android-Hülle fehlen noch in den Lizenzhinweisen.

**Beim Landen auf `main`:** neben T1 hängt jetzt `0102_geraetetoken_kette` an
`0101_voip_tokens`; `services/**` ist geändert, die Windows-Server-App braucht
deshalb einen Versions-Bump.
