# Direktweg-Mitgliedschaftsnachweis (24. Oktober 2026)

**Entscheidung von Michael, 24.10.2026** — ersetzt die Direktweg-Öffnung des
Heim-Server-V1-Entscheids vom 27.09.2026 („gemerkte Mitglieder dürfen die
Heim-Adresse sehen"), deren Schranke sich als wirkungslos erwies.

## Was passiert war (Security-Scan 24.10., Befund H2)

Die Cloud schaltete das Direktpfad-Telefonbuch (`GET /me/instances/{id}/
direct-endpoint`) für jede Membership-Zeile frei — Owner **oder** Mitglied.
„Mitglied werden" war aber eine nachweislose Selbst-Eintragung
(`POST /me/instances/{id}/membership`, Merkhilfe für die Server-Liste), und
die Instanz-Kennung steht unauthentifiziert in `/.well-known/
pulse-server-info`. Damit konnte **jedes beliebige Cloud-Konto** die
Heim-IP (inkl. Port) **jedes aktiven Heim-Servers** abrufen — ohne dass der
Betreiber es merkt. Kein Einbruch (der Draht dahinter verlangt weiterhin
Sitzungs-Ticket), aber die Privatheit der Heimanbindung war weg.

## Die Entscheidung

**Mitglied heißt jetzt: vom SERVER bestätigt.** Die Selbst-Eintragung bleibt
(als Merkhilfe für die Server-Liste über Geräte hinweg), aber nur der
Heim-Server selbst kann der Cloud eine Mitgliedschaft bestätigen:

1. Der Client löst wie bisher sein Cloud-Ticket am Server ein
   (`POST /session`). Das Beitritts-Gate prüft Einladungscode / öffentliche
   Community / Bestandsmitgliedschaft — wie seit Stufe 5.
2. **Neu:** Nach bestandenem Gate meldet der Server der Cloud die Kennung
   (`POST /api/auth/selfhost/directory/mitgliedschaft`, authentifiziert mit
   den Pairing-Creds wie der Heartbeat; der Gateway taktet die Meldung auf
   6 h je Mitglied — die Cloud prüft dabei Argon2).
3. Die Cloud setzt `user_instance_memberships.bestaetigt_am` (Migration
   0059). **Erst ein frisches `bestaetigt_am` schaltet Telefonbuch-Lookup
   und direct-offer frei** — Owner ausgenommen.

**Verfall:** Die Bestätigung gilt 7 Tage
(`directory_membership_gueltigkeit_tage`). Jede Anmeldung beim Server frischt
sie auf; ein Rauswurf oder Bann wird damit nach spätestens 7 Tagen wirksam,
ohne dass der Server der Cloud eine Abmeldung schicken müsste.

## Was sich für wen ändert

- **Betreiber (Owner):** nichts — die Owner-Rolle öffnet den Direktweg
  weiterhin ohne Bestätigung.
- **Mitglieder:** nichts Sichtbares — die App meldet sich ohnehin beim
  Öffnen des Servers an; das passiert automatisch. Wer länger als 7 Tage
  einen Server nicht öffnete, sieht ihn nach der nächsten Anmeldung wieder.
- **Angreifer:** Die Selbst-Eintragung allein öffnet nichts mehr (404 wie
  für Fremde). Die Instanz-Kennung aus `pulse-server-info` bringt nichts
  mehr, und Accounts lassen sich nicht „durchprobieren“, weil die Cloud
  nur noch Bestätigungen des jeweiligen SERVERS akzeptiert.
- **Alte Clients:** unverändert lauffähig — der Fix ist rein serverseitig
  (Auth-Dienst + Self-Host-Gateway). Bestandsmitglieder heilen bei der
  nächsten Anmeldung nach.

## Warum kein „Owner-only" (Stand 23.09.)?

Der Direktweg ist für Heim-Server ohne Relay der EINZIGe Zugang für
Mitglieder (Entscheid 27.09.). Owner-only hätte das Heim-Server-Produkt für
Freunde abgeschaltet. Der Nachweis-Weg hält beides: Freunde bleiben dran,
Fremde bleiben draußen.

## Verwandte Stellen

- `services/auth/src/dcc_auth/routes_selfhost_directory.py` — Bestätigungs-
  Route, `direktpfad_frei`, Lookup-Gate
- `services/auth/src/dcc_auth/routes_selfhost_signal.py` — Offer-Gate
  (geteilte Entscheidung über `direktpfad_frei`)
- `services/auth/src/dcc_auth/routes_instance_membership.py` — Merkhilfe
  ohne Nachweis (bewusst, öffnet nichts)
- `services/chat-gateway/src/dcc_chat_gateway/mitgliedschafts_meldung.py` —
  getaktete Meldung; `routes/session_ticket.py` — Auslöser nach dem Gate
- Tests: `test_directory_endpoints.py`, `test_direct_signal.py`,
  `test_instance_selfservice.py`, `test_session_ticket_route.py`
