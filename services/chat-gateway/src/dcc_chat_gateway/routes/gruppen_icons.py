"""Gruppenbild-Upload/Delete/Serve. Mitglieder schreiben, Serve anonym.

Dasselbe Muster wie ``routes.guild_icons`` (PIL: Resize auf 256x256 max,
WebP, Temp-Datei + Umbenennen nach dem Commit), mit DREI privaten Gruppen-
Unterschieden:

- **Schreiben darf JEDES Mitglied** — das Gruppenbild ist wie in jedem
  Messenger ein Gruppen-Eigentum, keine Besitzer-Fahne (Kicken bleibt Owner
  und Admins vorbehalten, das Bild nicht).
- **Serve anonym** wie bei Guild-Icons: ein ``<img>`` kann keinen
  Authorization-Kopf senden.
- **Die Adresse ist unratbar**: jeder Upload bekommt einen neuen Dateinamen
  ``<gruppe_id>-<zufall>.webp`` (``secrets.token_urlsafe``), und nur dieser
  Name steht in ``icon_url``. Wer die Gruppen-ID kennt, aber nicht Mitglied
  ist, kommt so nicht ans Bild — bei Guild-Icons (``<guild_id>.webp``)
  ginge das. Der wechselnde Name ist zugleich der Cache-Buster.

Publiziert wird ueber die Gruppen-Verteilung (``_gruppe_neu_publizieren``
in ``routes.private_gruppen``), damit alle Geraete der Mitglieder die
Kachel/der Kopf sofort neu laden.
"""

from __future__ import annotations

import asyncio
import io
import re
import secrets
from pathlib import Path

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

import dcc_chat_gateway.config as _config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.routes.private_gruppen import (
    _alle_wecken,
    _gruppe_fuer_mitglied_laden,
    _wire,
    require_private_groups_enabled,
)
from dcc_chat_gateway.security import CurrentUser

Image.MAX_IMAGE_PIXELS = 16 * 1024 * 1024

log = structlog.get_logger(__name__)
# Dieselben Riegel wie der Gruppen-Router — auch fuer das anonyme Serve:
# beide pruefen nur Instanzmodus und Schalter, keine Anmeldung.
router = APIRouter(dependencies=[CloudOnly, Depends(require_private_groups_enabled)])

_ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
_MAX_RAW_BYTES = 5 * 1024 * 1024
_MAX_DIM = 256
_URL_PREFIX = "/api/chat/gruppen-icons/"
# ``token_urlsafe(16)`` liefert genau 22 Zeichen aus [A-Za-z0-9_-]. Das
# strenge Muster ist zugleich der Schutz gegen Pfad-Traversal: kein ``/``,
# kein ``..``, nichts ausser Ziffern, Bindestrich, Token und ``.webp``.
_DATEINAME_RE = re.compile(r"^[0-9]{1,20}-[A-Za-z0-9_-]{22}\.webp$")


def _icon_dir() -> Path:
    return Path(_config.get_settings().gruppen_icon_upload_dir)


def _dateiname_aus_url(icon_url: str | None) -> str | None:
    """Der Dateiname hinter ``icon_url`` — nur, wenn er dem Muster genuegt."""
    if not icon_url or not icon_url.startswith(_URL_PREFIX):
        return None
    name = icon_url.removeprefix(_URL_PREFIX)
    return name if _DATEINAME_RE.fullmatch(name) else None


def _datei_loeschen(pfad: Path, gruppe_id: int) -> None:
    try:
        pfad.unlink(missing_ok=True)
    except OSError:
        log.warning("gruppen_icon_entfernen_fehlgeschlagen", gruppe_id=gruppe_id)


def icon_dateien_loeschen(gruppe_id: int) -> None:
    """Alle Bilddateien einer verschwindenden Gruppe entfernen — best-effort:
    ein Dateisystemfehler wird geloggt und kippt das Loeschen der Gruppe
    nicht. Gerufen aus ``gruppe_aufloesen`` und
    ``private_gruppen_atomar.gruppe_loeschen_wenn_leer``; die DB-Zeile (und
    damit ``icon_url``) ist dort schon weg, deshalb raeumt das Praefix der
    Gruppen-ID statt des gespeicherten Namens."""
    try:
        dateien = list(_icon_dir().glob(f"{int(gruppe_id)}-*.webp"))
    except OSError:
        log.warning("gruppen_icon_entfernen_fehlgeschlagen", gruppe_id=gruppe_id)
        return
    for pfad in dateien:
        _datei_loeschen(pfad, gruppe_id)


class _KaputtesBild(ValueError):
    """Decode-Check fehlgeschlagen → 400 (Muster ``guild_icons``)."""


def _icon_verarbeiten(raw: bytes, ziel: Path) -> None:
    """CPU-Teil im Thread-Pool (Muster ``guild_icons._icon_verarbeiten``)."""
    try:
        img = Image.open(io.BytesIO(raw))
        img.verify()
        img = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise _KaputtesBild("invalid image file") from exc
    img = ImageOps.exif_transpose(img)
    if img.mode in ("P", "LA"):
        img = img.convert("RGBA")
    img.thumbnail((_MAX_DIM, _MAX_DIM), Image.LANCZOS)
    img.save(ziel, "WEBP", quality=85)


@router.post("/gruppen/{gruppe_id}/icon", status_code=status.HTTP_200_OK)
async def icon_setzen(
    gruppe_id: int,
    file: UploadFile,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
):
    """Gruppenbild setzen — JEDES Mitglied (wie in jedem Messenger)."""
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)

    if file.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="unsupported image type")
    raw = await file.read(_MAX_RAW_BYTES + 1)
    if len(raw) > _MAX_RAW_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="file too large (max 5 MB)")

    verzeichnis = _icon_dir()
    verzeichnis.mkdir(parents=True, exist_ok=True)
    dateiname = f"{gruppe.id}-{secrets.token_urlsafe(16)}.webp"
    icon_tmp = verzeichnis / f"{dateiname}.tmp"
    try:
        await asyncio.to_thread(_icon_verarbeiten, raw, icon_tmp)
    except _KaputtesBild as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid image file") from exc

    alter_name = _dateiname_aus_url(gruppe.icon_url)
    gruppe.icon_url = f"{_URL_PREFIX}{dateiname}"
    await session.commit()
    icon_tmp.replace(verzeichnis / dateiname)
    # Nur die Datei, die die Zeile bis eben nannte — nicht „alle ausser der
    # neuen": zwei gleichzeitige Uploads raeumten sich sonst gegenseitig die
    # gerade gespeicherte weg. Im Rennen bleibt hoechstens eine Waise liegen,
    # die spaetestens mit der Gruppe geht (``icon_dateien_loeschen``).
    if alter_name:
        _datei_loeschen(verzeichnis / alter_name, gruppe.id)

    mitglieder = await _alle_wecken(request, session, gruppe.id)
    log.info("gruppen_icon_gesetzt", gruppe_id=gruppe.id, user_id=user.id)
    return _wire(gruppe, mitglieder, user.id)


@router.delete("/gruppen/{gruppe_id}/icon")
async def icon_entfernen(
    gruppe_id: int,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
):
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    alter_name = _dateiname_aus_url(gruppe.icon_url)
    gruppe.icon_url = None
    await session.commit()
    if alter_name:
        _datei_loeschen(_icon_dir() / alter_name, gruppe.id)

    mitglieder = await _alle_wecken(request, session, gruppe.id)
    return _wire(gruppe, mitglieder, user.id)


@router.get("/gruppen-icons/{dateiname}", include_in_schema=False)
async def icon_servieren(dateiname: str) -> FileResponse:
    """Anonym wie ``guild-icons``: ein ``<img>`` sendet keinen
    Authorization-Kopf. Ausgeliefert wird nur ein Name, der dem strengen
    Muster genuegt UND als Datei existiert — die Adresse kennt nur, wer sie
    als Mitglied in ``icon_url`` gesehen hat (Modulkopf)."""
    if not _DATEINAME_RE.fullmatch(dateiname):
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    path = _icon_dir() / dateiname
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return FileResponse(
        path,
        media_type="image/webp",
        # ``private``: das Bild gehoert einer privaten Gruppe, kein geteilter
        # Zwischenspeicher soll es halten. Der Name wechselt mit jedem Upload,
        # die lange Frist veraltet deshalb nie.
        headers={"Cache-Control": "private, max-age=604800"},
    )
