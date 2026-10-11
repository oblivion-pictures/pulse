"""``GET /.well-known/pulse-verbinden`` — der Nachweis beim Verbinden (Spec 2026-10-09, E2).

Während ``pulse-connect`` auf die Bestätigung im Browser wartet, liegt in
``<pulse_verbinden_dir>/verbinden-nachweis`` der SHA-256 seiner geheimen
Abholkennung. Die Cloud bekommt beim Anfragen des Gerätecodes die Kennung
selbst, bildet den Hash und vergleicht ihn mit dem Wert hier — beim Anfragen
und noch einmal vor dem Eintragen. Wer eine fremde Adresse für sich eintragen
will, kann dort keinen passenden Wert hinlegen.

Anonym, weil die Cloud sich gegenüber einem Server, den sie noch gar nicht
kennt, nicht ausweisen kann. Preisgegeben wird nichts, was einem Dritten
nützt: der Hash öffnet nichts — anfragen und abholen kann nur, wer die Kennung
selbst hat (deshalb schickt ``pulse-connect`` beim Anfragen die Kennung und
nicht den Hash, Vertrag Nachtrag 2).
Ohne Datei — der Normalfall, auch auf jedem Bestandsserver — antwortet die
Route 404. Keine Bremse: eine Antwort kostet das Lesen einer Datei von 65
Byte, ohne Datenbank und ohne Redis.

Nur auf einem Self-Host: die Cloud verbindet sich nicht mit sich selbst.
Braucht eine Zeile im ``Caddyfile.template`` (Muster ``owner_check.py``).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

# Modul-Zugriff statt ``from … import get_settings`` — Begründung in
# ``owner_check.py`` (Tests tauschen den Anbieter aus).
from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.verbindung import nachweis_lesen

router = APIRouter()


class NachweisAus(BaseModel):
    nachweis: str


@router.get("/.well-known/pulse-verbinden", response_model=NachweisAus)
async def verbinden_nachweis() -> NachweisAus:
    settings = chat_config.get_settings()
    wert = None
    if settings.pulse_instance_mode == "self-host":
        wert = nachweis_lesen(Path(settings.pulse_verbinden_dir))
    if wert is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return NachweisAus(nachweis=wert)
