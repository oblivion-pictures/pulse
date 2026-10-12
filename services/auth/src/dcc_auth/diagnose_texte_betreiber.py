"""Die Sätze zum Betreiber-Glied der Erreichbarkeitsprüfung.

Eigenes Modul, weil ``diagnose_texte.py`` mit 348 Zeilen an der weichen Grenze
der Größen-Policy steht (PLAN.md §12.1). Es mischt die drei Tabellen hier in
seine eigenen — **die einzige Quelle für Diagnose-Texte bleibt damit
``diagnose_texte``**, hier liegt nur ein Teil davon.

Der Adressat ist derselbe wie dort: jemand, der gerade nicht weiterkommt und
einen Handgriff braucht, keine Zustandsbeschreibung. ``was_tun`` ist deshalb
auch hier Pflicht.
"""

from __future__ import annotations

#: (de, en)
TITEL: tuple[str, str] = ("Betreiber-Erkennung", "Owner recognition")

GELUNGEN: tuple[str, str] = (
    "Der Server erkennt dich als seinen Betreiber.",
    "The server recognises you as its owner.",
)

#: ``(schritt, befund) -> ((was_ist_de, was_tun_de), (was_ist_en, was_tun_en))``
BEFUNDE: dict[tuple[str, str], tuple[tuple[str, str], tuple[str, str]]] = {
    ("betreiber", "andere_kennung"): (
        (
            "Dieser Server ist auf ein anderes Konto als Betreiber eingestellt — nicht auf deines. "
            "Deshalb bist du dort ein gewöhnliches Mitglied: Du kannst keine Community anlegen und "
            "die Server-Einstellungen nicht öffnen, obwohl der Server dir gehört. Am häufigsten "
            "passiert das, wenn die Konfigurationsdatei eines früheren Servers weiterverwendet wurde.",
            "Verbinde den Server neu mit dem Konto, dem er gehören soll: sudo docker exec -it "
            "{container} pulse-connect — dann den angezeigten Link öffnen und mit diesem Konto "
            "bestätigen; danach in der App einmal neu laden. Ausnahme: Ein Server, der vor Oktober "
            "2026 mit Freigabe eingerichtet wurde, trägt den Besitzer als PULSE_INSTANCE_OWNER_ID in "
            "seiner Konfigurationsdatei (Installer: /opt/pulse/pulse.env bzw. ~/.pulse/pulse.env, "
            "Compose: .env neben der Compose-Datei). Dort die Kennung auf {kennung} setzen und "
            "den Container neu anlegen, ein Neustart liest die Datei nicht neu: beim Installer "
            "den Installationsbefehl erneut ausführen (er behält Bild und Konfiguration), bei "
            "Compose sudo docker compose up -d.",
        ),
        (
            "This server is configured with a different account as its owner — not yours. That makes "
            "you an ordinary member there: you cannot create a community or open the server settings, "
            "even though the server is yours. The most common cause is a configuration file carried "
            "over from an earlier server.",
            "Connect the server again with the account that should own it: sudo docker exec -it "
            "{container} pulse-connect — then open the link it shows and confirm with that account; "
            "afterwards reload the app once. Exception: a server set up before October 2026 with an "
            "approval carries its owner as PULSE_INSTANCE_OWNER_ID in its configuration file "
            "(installer: /opt/pulse/pulse.env or ~/.pulse/pulse.env, Compose: the .env next to the "
            "compose file). Set the identifier there to {kennung} and "
            "recreate the container, a restart does not reread the file: with the installer run "
            "the install command again (it keeps image and configuration), with Compose run sudo "
            "docker compose up -d.",
        ),
    ),
    ("betreiber", "nicht_konfiguriert"): (
        (
            "Dieser Server weiss gar nicht, wem er gehört. Damit kann ihn niemand verwalten — auch du "
            "nicht.",
            "Verbinde den Server mit deinem Konto: sudo docker exec -it {container} pulse-connect — "
            "dann den angezeigten Link öffnen und bestätigen. Ausnahme: Ein Server, der vor Oktober "
            "2026 mit Freigabe eingerichtet wurde, trägt den Besitzer als PULSE_INSTANCE_OWNER_ID in "
            "seiner Konfigurationsdatei (Installer: /opt/pulse/pulse.env bzw. ~/.pulse/pulse.env, "
            "Compose: .env neben der Compose-Datei). Dort die Kennung {kennung} eintragen und "
            "den Container neu anlegen, ein Neustart liest die Datei nicht neu: beim Installer "
            "den Installationsbefehl erneut ausführen (er behält Bild und Konfiguration), bei "
            "Compose sudo docker compose up -d.",
        ),
        (
            "This server does not know who it belongs to. Nobody can administer it that way — not "
            "even you.",
            "Connect the server to your account: sudo docker exec -it {container} pulse-connect — "
            "then open the link it shows and confirm. Exception: a server set up before October 2026 "
            "with an approval carries its owner as PULSE_INSTANCE_OWNER_ID in its configuration file "
            "(installer: /opt/pulse/pulse.env or ~/.pulse/pulse.env, Compose: the .env next to the "
            "compose file). Enter the identifier {kennung} there and "
            "recreate the container, a restart does not reread the file: with the installer run "
            "the install command again (it keeps image and configuration), with Compose run sudo "
            "docker compose up -d.",
        ),
    ),
    ("betreiber", "kein_self_host"): (
        (
            "Dieser Server läuft nicht in der Betriebsart für eigene Server. In dieser Einstellung "
            "wird niemand zum Verwalter ernannt, auch nicht mit der richtigen Kennung.",
            "Setze in der Konfigurationsdatei des Servers (Installer: /opt/pulse/pulse.env bzw. "
            "~/.pulse/pulse.env, Compose: .env neben der Compose-Datei) PULSE_INSTANCE_MODE=self-host "
            "und lege den Container neu an, ein Neustart liest die Datei nicht neu: beim "
            "Installer den Installationsbefehl erneut ausführen (er behält Bild und "
            "Konfiguration), bei Compose sudo docker compose up -d.",
        ),
        (
            "This server is not running in the mode meant for your own servers. In that setting nobody "
            "is made an administrator, not even with the correct identifier.",
            "In the server's configuration file (installer: /opt/pulse/pulse.env or "
            "~/.pulse/pulse.env, Compose: the .env next to the compose file) set "
            "PULSE_INSTANCE_MODE=self-host and recreate the container, a restart does not reread "
            "the file: with the installer run the install command again (it keeps image and "
            "configuration), with Compose run sudo docker compose up -d.",
        ),
    ),
    ("betreiber", "signatur_abgelehnt"): (
        (
            "Der Server hat die Anfrage abgewiesen, weil er sie nicht als von howispulse.com kommend "
            "bestätigen konnte. Dafür gibt es zwei Ursachen: Entweder hat er die Cloud selbst noch "
            "nie erreicht — dann funktioniert auch die Anmeldung über dein Konto dort nicht. Oder "
            "seine Uhr geht mehr als eine Minute falsch; dann hält er die Anfrage für abgelaufen, "
            "obwohl sie gerade erst gestellt wurde.",
            "Prüfe beides auf der Maschine: die Uhr mit date -u (sie muss auf die Minute stimmen; "
            "wenn nicht, Zeitabgleich einschalten mit sudo timedatectl set-ntp true), und den Weg "
            "nach draussen mit docker exec {container} pulse-doctor, Abschnitt „Verbindung zur "
            "Cloud“. Ein ausgehender Sperrfilter oder ein Proxy-Zwang ist dort die übliche Ursache.",
        ),
        (
            "The server rejected the request because it could not confirm it came from howispulse.com. "
            "There are two causes: either it has never reached the cloud itself — in that case signing "
            "in with your account there does not work either. Or its clock is off by more than a "
            "minute, so it considers the request expired even though it was just made.",
            "Check both on the machine: the clock with date -u (it must be correct to the minute; if "
            "not, enable time sync with sudo timedatectl set-ntp true), and the route outwards with "
            "docker exec {container} pulse-doctor, \"Verbindung zur Cloud\" section. An outbound "
            "firewall or a mandatory proxy is the usual cause there.",
        ),
    ),
    ("betreiber", "keine_auskunft"): (
        (
            "Dieser Server kann diese Auskunft noch nicht geben — er läuft mit einer älteren Fassung. "
            "Das ist kein Fehler: Alles andere an ihm ist in Ordnung, nur diese eine Prüfung entfällt.",
            "Nichts zu tun. Der Server holt sich die neue Fassung von selbst; danach beantwortet er "
            "die Frage beim nächsten Prüflauf mit.",
        ),
        (
            "This server cannot answer this yet — it runs an older version. That is not a fault: "
            "everything else about it is fine, only this one check is skipped.",
            "Nothing to do. The server picks up the new version by itself; after that it answers this "
            "question on the next check.",
        ),
    ),
}


#: Heim-Server (``origin="app_host"``, die Server-App): kein Installer, kein
#: Compose, kein ``docker exec`` — die Server-App schreibt Betriebsart und
#: Besitzer bei jedem Start selbst in die Konfiguration
#: (``desktop/electron/localBackend/nativeBackend/envContract.ts``,
#: ``containerEnv.ts``) und führt für jedes angemeldete Konto einen eigenen
#: Server. Befunde, die hier fehlen, gelten für beide Arten gleich.
BEFUNDE_HEIMSERVER: dict[tuple[str, str], tuple[tuple[str, str], tuple[str, str]]] = {
    ("betreiber", "andere_kennung"): (
        (
            "Dieser Server hält ein anderes Konto für seinen Betreiber als dich. Deshalb bist du dort "
            "ein gewöhnliches Mitglied: Du kannst keine Community anlegen und die "
            "Server-Einstellungen nicht öffnen, obwohl der Server dir gehört.",
            "Melde dich in der Server-App mit dem Konto an, dem dieser Server gehört, und starte ihn "
            "dort neu (Server stoppen, Server starten). Die Server-App führt für jedes Konto einen "
            "eigenen Server und schreibt beim Start den Besitzer neu in seine Konfiguration. Danach "
            "in der App einmal neu laden.",
        ),
        (
            "This server considers a different account its owner than you. That makes you an ordinary "
            "member there: you cannot create a community or open the server settings, even though the "
            "server is yours.",
            "Sign in to the server app with the account that owns this server and restart it there "
            "(stop the server, start the server). The server app keeps a separate server for each "
            "account and writes the owner into its configuration on every start. Afterwards reload "
            "the app once.",
        ),
    ),
    ("betreiber", "nicht_konfiguriert"): (
        (
            "Dieser Server weiß nicht, wem er gehört. So kann ihn niemand verwalten, auch du nicht.",
            "Starte den Server in der Server-App neu (Server stoppen, Server starten), angemeldet mit "
            "dem Konto, dem er gehört. Beim Start schreibt die Server-App den Besitzer in seine "
            "Konfiguration.",
        ),
        (
            "This server does not know who it belongs to. Nobody can administer it that way, not "
            "even you.",
            "Restart the server in the server app (stop the server, start the server) while signed in "
            "with the account that owns it. On start the server app writes the owner into its "
            "configuration.",
        ),
    ),
    ("betreiber", "kein_self_host"): (
        (
            "Dieser Server läuft nicht in der Betriebsart für eigene Server. In dieser Einstellung "
            "wird niemand zum Verwalter ernannt, auch nicht mit der richtigen Kennung.",
            "Die Server-App setzt diese Betriebsart bei jedem Start selbst. Bring sie auf den "
            "neuesten Stand und starte den Server neu (Server stoppen, Server starten).",
        ),
        (
            "This server is not running in the mode meant for your own servers. In that setting "
            "nobody is made an administrator, not even with the correct identifier.",
            "The server app sets this mode itself on every start. Update it to the latest version "
            "and restart the server (stop the server, start the server).",
        ),
    ),
    ("betreiber", "signatur_abgelehnt"): (
        (
            "Der Server hat die Anfrage abgewiesen, weil er sie nicht als von howispulse.com kommend "
            "bestätigen konnte. Dafür gibt es zwei Ursachen: Entweder hat er die Cloud selbst noch "
            "nie erreicht, dann funktioniert auch die Anmeldung über dein Konto dort nicht. Oder "
            "die Uhr des Rechners geht mehr als eine Minute falsch; dann hält er die Anfrage für "
            "abgelaufen, obwohl sie gerade erst gestellt wurde.",
            "Prüfe beides auf dem Rechner, auf dem die Server-App läuft: Die Uhr muss auf die Minute "
            "stimmen (in den Systemeinstellungen die Uhrzeit automatisch stellen lassen), und "
            "https://howispulse.com muss sich dort im Browser öffnen lassen. Ein Sperrfilter für "
            "ausgehende Verbindungen oder ein Proxy-Zwang ist die übliche Ursache.",
        ),
        (
            "The server rejected the request because it could not confirm it came from howispulse.com. "
            "There are two causes: either it has never reached the cloud itself, in which case signing "
            "in with your account there does not work either. Or the computer's clock is off by more "
            "than a minute, so it considers the request expired even though it was just made.",
            "Check both on the computer running the server app: the clock must be correct to the "
            "minute (let the system set the time automatically), and https://howispulse.com must "
            "open in a browser there. An outbound firewall or a mandatory proxy is the usual cause.",
        ),
    ),
    ("betreiber", "keine_auskunft"): (
        (
            "Dieser Server kann diese Auskunft noch nicht geben, er läuft mit einer älteren Fassung. "
            "Das ist kein Fehler: Alles andere an ihm ist in Ordnung, nur diese eine Prüfung entfällt.",
            "Bring die Server-App auf den neuesten Stand; danach beantwortet der Server die Frage "
            "beim nächsten Prüflauf mit.",
        ),
        (
            "This server cannot answer this yet, it runs an older version. That is not a fault: "
            "everything else about it is fine, only this one check is skipped.",
            "Update the server app to the latest version; after that the server answers this "
            "question on the next check.",
        ),
    ),
}
