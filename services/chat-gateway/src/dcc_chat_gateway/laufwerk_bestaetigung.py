"""Eine Laufwerks-Adresse wird erst gespeichert, wenn sie sich als Laufwerk erweist.

**Warum** (Gegenprüfung des Security-Audits, 2026-11-05): Beim Hinterlegen
einer Freigabe-Adresse (persönliches Archiv, Community-Laufwerk,
Ablage-Kanal) wurde nur das Schema geprüft. Danach reichte der Server alles,
was unter der Adresse lag, über die Abruf-Routen an den Aufrufer zurück — bis
8 MiB, 300-mal je Minute und Konto. Eine beliebige öffentliche Webseite als
„Laufwerk“ eingetragen machte den Server so zum offenen HTTP-Proxy, mit der
eigenen IP als Absender.

**Jetzt** muss die Adresse beim Setzen eine Probe bestehen, und zwar über
GENAU die Wege, die das Laufwerk später benutzt: eine Probedatei per
`ablage_schreiben.schreibe` ablegen, per `ablage_ssrf.hole` zurücklesen,
vergleichen, per `ablage_schreiben.loesche` entfernen — alle mit der Adresse
wörtlich als WebDAV-Basis. Das kann nur ein beschreibbares WebDAV-Laufwerk;
eine fremde Webseite scheitert am Schreiben.

**Hier stand zuerst `ablage_probe.probiere_ziel`** (der Verbinden-Dialog der
Kanal-Ablage). Die zerlegt einen Nextcloud-Freigabe-Link (`…/s/<token>`) —
das Archiv speichert aber die daraus abgeleitete WebDAV-Basis
(`…/public.php/dav/files/<token>`, `web/src/lib/ablage/freigabeLink.ts`), und
jede neue Archiv-Verbindung scheiterte daran (2026-11-05, wenige Stunden nach
dem Ausrollen bemerkt). Zugleich probte sie eine ANDERE Adresse als die, die
später gelesen wird. Beides behebt die Probe über die echten Wege.

**Nur `https`.** Bei `http://` könnte ein Name, der zur Probe auf ein
Laufwerk zeigte, danach auf eine beliebige öffentliche IP umgebogen werden
(DNS-Rebinding): die Abrufe gingen dann dorthin, mit fremdem Host-Kopf. Mit
TLS scheitert das an der Zertifikatsprüfung gegen den Namen. Private Netze
sind ohnehin gesperrt (`ablage_ssrf`), ein Laufwerk ohne TLS im Internet
gibt es nicht ernsthaft.

Den zweiten Weg — ein eigenes Laufwerk, das beim Abruf auf eine fremde Seite
umleitet — schließt `ablage_ssrf.hole`, das nur noch Umleitungen auf
denselben Host verfolgt.

**Eine unveränderte Adresse wird nicht erneut geprobt.** Der Klient trägt eine
gemerkte Adresse selbsttätig nach (`archivAdapter.ts`, `archivServerAbgleich.ts`);
jedes Mal eine Probedatei zu schreiben, wäre Last ohne Erkenntnis.
"""

from __future__ import annotations

import secrets
import urllib.parse

from fastapi import HTTPException, status

from dcc_chat_gateway.ablage_probe import PROBE_BYTES, ProbeErgebnis, _probe_dateiname
from dcc_chat_gateway.ablage_schreiben import loesche, schreibe
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler, hole

FRIST_S = 20.0


async def _ueber_die_echten_wege(*, freigabe_adresse: str) -> ProbeErgebnis:
    """Schreiben, lesen, vergleichen, löschen — mit der Adresse als Basis."""
    datei = _probe_dateiname()
    inhalt = secrets.token_bytes(PROBE_BYTES)
    try:
        await schreibe(basis=freigabe_adresse, pfad=datei, inhalt=inhalt, timeout_s=FRIST_S)
    except AblageAbrufFehler as fehler:
        return ProbeErgebnis(False, "schreiben", fehler.code)
    lesefehler: ProbeErgebnis | None = None
    try:
        gelesen = await hole(
            basis=freigabe_adresse, pfad=datei, max_bytes=PROBE_BYTES * 2, timeout_s=FRIST_S
        )
        if gelesen.inhalt != inhalt:
            lesefehler = ProbeErgebnis(False, "vergleichen", "inhalt_weicht_ab")
    except AblageAbrufFehler as fehler:
        lesefehler = ProbeErgebnis(False, "lesen", fehler.code)
    # Auch nach einem Lesefehler: keine Probedatei im Ordner des Nutzers
    # liegen lassen. Scheitert das Löschen, zählt die Probe nicht.
    try:
        await loesche(basis=freigabe_adresse, pfad=datei, timeout_s=FRIST_S)
    except AblageAbrufFehler as fehler:
        return lesefehler or ProbeErgebnis(False, "loeschen", fehler.code)
    return lesefehler or ProbeErgebnis(True)


# Eigener Name, damit Tests die Probe HIER ersetzen können (`tests/conftest.py`).
_probiere = _ueber_die_echten_wege


async def adresse_bestaetigen(freigabe_adresse: str, bisher: str | None = None) -> None:
    """Wirft 400, wenn ``freigabe_adresse`` kein ``https`` ist oder die Probe
    nicht besteht. ``bisher``: die gespeicherte Adresse; ist sie gleich, gilt
    sie schon als bestätigt."""
    if bisher == freigabe_adresse:
        return
    if urllib.parse.urlsplit(freigabe_adresse).scheme != "https":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="drive address must use https")
    ergebnis = await _probiere(freigabe_adresse=freigabe_adresse)
    if not ergebnis.gut:
        # Nur Schritt und Kennung, nie die Adresse (Modulkopf von `ablage_probe`).
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"drive probe failed: {ergebnis.schritt}/{ergebnis.grund}",
        )
