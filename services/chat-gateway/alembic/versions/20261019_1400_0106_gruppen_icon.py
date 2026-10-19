"""Gruppenbild — Spalte ``icon_url`` an ``private_group_channels``.

Nutzerwunsch 2026-10-19: ein Gruppenbild, das statt der
Anfangsbuchstaben-Kachel an Kachel, Kopf und Sheet haengt. Dasselbe Muster
wie ``Guild.icon_url``: die Spalte traegt den Pfad
(``/api/chat/gruppen-icons/<id>.webp?v=<cache-buster>``), die Datei liegt
ausserhalb der DB unter ``gruppen_icon_upload_dir`` (Route
``routes.gruppen_icons``). Nullable — null = kein Bild.

Revision ID: 0106_gruppen_icon
Revises: 0105_geraetetoken_kette
Create Date: 2026-10-19 14:00:00.000000+00:00
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0106_gruppen_icon"
down_revision: str | Sequence[str] | None = "0105_geraetetoken_kette"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "private_group_channels",
        sa.Column("icon_url", sa.String(length=255), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("private_group_channels", "icon_url", schema=SCHEMA)
