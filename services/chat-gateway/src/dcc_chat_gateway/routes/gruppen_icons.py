"""Gruppenbild-Upload/Delete/Serve. Mitglieder schreiben, Serve anonym.

Dasselbe Muster wie ``routes.guild_icons`` (PIL: Resize auf 256x256 max,
WebP, Temp-Datei + Umbenennen nach dem Commit), mit ZWEI privaten Gruppen-
Unterschieden:

- **Schreiben darf JEDES Mitglied** — das Gruppenbild ist wie in jedem
  Messenger ein Gruppen-Eigentum, keine Besitzer-Fahne (Kicken bleibt dem
  Ersteller vorbehalten, das Bild nicht).
- **Serve anonym** wie bei Guild-Icons: ein ``<img>`` kann keinen
  Authorization-Kopf senden. Die Adresse ist nur aus der Mitgliedschaft
  bekannt; der Cache-Buster in ``icon_url`` verhindert staendige Versionen.

Publiziert wird ueber die Gruppen-Verteilung (``_gruppe_neu_publizieren``
in ``routes.private_gruppen``), damit alle Geraete der Mitglieder die
Kachel/der Kopf sofort neu laden.
"""

from __future__ import annotations

import asyncio
import io
import secrets
from pathlib import Path

import dcc_chat_gateway.config as _config
import structlog
from fastapi import APIRouter, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 16 * 1024 * 1024

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.routes.private_gruppen import (
    _gruppe_fuer_mitglied_laden,
    _gruppe_neu_publizieren,
    _mitglieder_laden,
    _wire,
)

log = structlog.get_logger(__name__)
router = APIRouter()

_ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
_MAX_RAW_BYTES = 5 * 1024 * 1024
_MAX_DIM = 256


def _icon_dir() -> Path:
    d = Path(_config.get_settings().gruppen_icon_upload_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _icon_path(gruppe_id: int) -> Path:
    return _icon_dir() / f"{gruppe_id}.webp"


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
        img.convert("RGBA")
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

    icon_tmp = _icon_path(gruppe.id).with_suffix(".webp.tmp")
    try:
        await asyncio.to_thread(_icon_verarbeiten, raw, icon_tmp)
    except _KaputtesBild as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid image file") from exc

    gruppe.icon_url = f"/api/chat/gruppen-icons/{gruppe.id}.webp?v={secrets.token_urlsafe(6)}"
    await session.commit()
    icon_tmp.replace(_icon_path(gruppe.id))

    mitglieder = await _mitglieder_laden(session, gruppe.id)
    empfaenger = {m.user_id for m in mitglieder}
    await _gruppe_neu_publizieren(request, empfaenger, gruppe.id)
    log.info("gruppen_icon_gesetzt", gruppe_id=gruppe.id, user_id=user.id)
    mitglieder = await _mitglieder_laden(session, gruppe.id)
    return _wire(gruppe, mitglieder)


@router.delete("/gruppen/{gruppe_id}/icon")
async def icon_entfernen(
    gruppe_id: int,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
):
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    gruppe.icon_url = None
    await session.commit()
    try:
        _icon_path(gruppe.id).unlink(missing_ok=True)
    except OSError:
        log.warning("gruppen_icon_entfernen_fehlgeschlagen", gruppe_id=gruppe.id)

    mitglieder = await _mitglieder_laden(session, gruppe.id)
    empfaenger = {m.user_id for m in mitglieder}
    await _gruppe_neu_publizieren(request, empfaenger, gruppe.id)
    mitglieder = await _mitglieder_laden(session, gruppe.id)
    return _wire(gruppe, mitglieder)


@router.get("/gruppen-icons/{gruppe_id}.webp", include_in_schema=False)
async def icon_servieren(gruppe_id: int) -> FileResponse:
    """Anonym wie ``guild-icons``: ein ``<img>`` sendet keinen
    Authorization-Kopf. Die Adresse haengt an der Mitgliedschaft (die
    Gruppe ist nur ihren Mitgliedern bekannt) — der Kompromiss steht im
    Modulkopf."""
    path = _icon_path(gruppe_id)
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return FileResponse(
        path,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=604800"},
    )
