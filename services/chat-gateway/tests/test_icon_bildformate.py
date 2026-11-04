"""Security-Scan 2026-11-04: Icon-Uploads dekodieren nur PNG/JPEG/WEBP.

Der Content-Type eines Uploads stammt vom Client; ohne ``formats=`` beim
Oeffnen reicht Pillow jedes bekannte Format an seinen Decoder weiter — auch
die Exoten mit bekannten Speicherfehlern (JPEG2000, GD, EPS …).
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from dcc_chat_gateway.routes import gruppen_icons, guild_icons


def _bild(fmt: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), color=(10, 20, 30)).save(buf, fmt)
    return buf.getvalue()


@pytest.mark.parametrize("modul", [guild_icons, gruppen_icons])
@pytest.mark.parametrize("fmt", ["BMP", "TGA", "GIF"])
def test_exotisches_format_wird_abgelehnt(modul, fmt, tmp_path):
    with pytest.raises(modul._KaputtesBild):
        modul._icon_verarbeiten(_bild(fmt), tmp_path / "x.webp")
    assert not (tmp_path / "x.webp").exists()


@pytest.mark.parametrize("modul", [guild_icons, gruppen_icons])
@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
def test_erlaubtes_format_wird_verarbeitet(modul, fmt, tmp_path):
    modul._icon_verarbeiten(_bild(fmt), tmp_path / "x.webp")
    assert (tmp_path / "x.webp").stat().st_size > 0
