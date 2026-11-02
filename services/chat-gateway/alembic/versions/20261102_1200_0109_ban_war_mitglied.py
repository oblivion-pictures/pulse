"""Bann merkt sich, ob das Ziel Mitglied war — Spalte ``was_member``.

Bughunt 2026-11-02: ``DELETE /guilds/{g}/bans/{uid}`` schickte JEDEM
Entbannten eine Moderations-DM mit Einladung, auch wer nie Mitglied war. Weil
Bannen keine Mitgliedschaft voraussetzt (vorsorgliches Bannen ist gewollt),
konnte jeder Community-Eigentümer mit Bannen + Entbannen beliebigen Konten
schreiben — an Freundschaftspflicht und Blockade vorbei. Seither gibt es die
Nachricht nur, wenn das Ziel beim Bannen Mitglied war.

Bestehende Banne stehen auf ``true``: für sie gilt das bisherige Verhalten,
weil sich nicht mehr feststellen lässt, ob das Ziel damals Mitglied war.

Revision ID: 0109_ban_war_mitglied
Revises: 0108_webpush_kette
Create Date: 2026-11-02 12:00:00.000000+00:00
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0109_ban_war_mitglied"
down_revision: str | Sequence[str] | None = "0108_webpush_kette"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "guild_bans",
        sa.Column("was_member", sa.Boolean(), nullable=False, server_default=sa.true()),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("guild_bans", "was_member", schema=SCHEMA)
