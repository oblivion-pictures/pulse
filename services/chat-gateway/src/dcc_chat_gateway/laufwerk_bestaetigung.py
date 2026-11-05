"""Eine Laufwerks-Adresse wird erst gespeichert, wenn sie sich als Laufwerk erweist.

**Warum** (Gegenprüfung des Security-Audits, 2026-11-05): Beim Hinterlegen
einer Freigabe-Adresse (persönliches Archiv, Community-Laufwerk,
Ablage-Kanal) wurde nur das Schema geprüft. Danach reichte der Server alles,
was unter der Adresse lag, über die Abruf-Routen an den Aufrufer zurück — bis
8 MiB, 300-mal je Minute und Konto. Eine beliebige öffentliche Webseite als
„Laufwerk“ eingetragen machte den Server so zum offenen HTTP-Proxy, mit der
eigenen IP als Absender.

**Jetzt** muss die Adresse beim Setzen die Verbindungsprobe bestehen
(`ablage_probe.probiere_ziel`: Probedatei schreiben, lesen, vergleichen,
löschen). Das kann nur ein beschreibbares WebDAV-Laufwerk; eine fremde
Webseite scheitert am Schreiben. Den zweiten Weg — ein eigenes Laufwerk, das
beim Abruf auf eine fremde Seite umleitet — schließt `ablage_ssrf.hole`, das
nur noch Umleitungen auf denselben Host verfolgt.

**Eine unveränderte Adresse wird nicht erneut geprobt.** Der Klient trägt eine
gemerkte Adresse selbsttätig nach (`archivAdapter.ts`, `archivServerAbgleich.ts`);
jedes Mal eine Probedatei zu schreiben, wäre Last ohne Erkenntnis.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from dcc_chat_gateway import ablage_probe

# Eigener Name, damit Tests die Probe HIER ersetzen können, ohne die Tests der
# Probe selbst (`ablage_probe.probiere_ziel`) zu berühren (`tests/conftest.py`).
_probiere = ablage_probe.probiere_ziel


async def adresse_bestaetigen(freigabe_adresse: str, bisher: str | None = None) -> None:
    """Wirft 400, wenn ``freigabe_adresse`` die Verbindungsprobe nicht besteht.
    ``bisher``: die gespeicherte Adresse; ist sie gleich, gilt sie schon als
    bestätigt."""
    if bisher == freigabe_adresse:
        return
    ergebnis = await _probiere(freigabe_adresse=freigabe_adresse)
    if not ergebnis.gut:
        # Nur Schritt und Kennung, nie die Adresse (Modulkopf von `ablage_probe`).
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"drive probe failed: {ergebnis.schritt}/{ergebnis.grund}",
        )
