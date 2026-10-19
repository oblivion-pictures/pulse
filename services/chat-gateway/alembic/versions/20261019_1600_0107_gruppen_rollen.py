"""Gruppen-Rollen, Stummschalten und Anheften.

Nutzerwunsch 2026-10-19 (Rollen-Struktur + „alle gängigen Funktionen"):

- ``private_group_members.rolle``: ``owner`` / ``admin`` / ``mitglied``.
  Owner ist die übertragbare Besitzerrolle (``ersteller_id``) — die Spalte
  hält die Rolle der ÜBRIGEN Zeilen (``admin`` = einladen + rauswerfen).
  Rückfüllung: die Zeile des aktuellen Erstellers wird ``owner``.
- ``private_group_members.stumm``: persönliche Stummschaltung je (Mitglied,
  Gruppe) — das Handy-Bein des Push-Versands respektiert sie
  (``fcm_warteschlange``), die UI schaltet sie im Gruppen-Blatt um.
- ``private_group_channels.angeheftet_id``: EIN angehefteter Kanal-Anker
  (die kanonische ID, die der Anpinnende wählt — sie fährt verschlüsselt in
  der Nachricht; der Server sieht nur die Zeichenkette). Alle Mitglieder
  dürfen anpinnen/lösen.

Revision ID: 0107_gruppen_rollen
Revises: 0105_geraetetoken_kette
Create Date: 2026-10-19 16:00:00.000000+00:00
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0107_gruppen_rollen"
down_revision: str | Sequence[str] | None = "0106_gruppen_icon"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "private_group_members",
        sa.Column("rolle", sa.String(length=16), nullable=False,
                  server_default="mitglied"),
        schema=SCHEMA,
    )
    op.add_column(
        "private_group_members",
        sa.Column("stumm", sa.Boolean(), nullable=False, server_default=sa.false()),
        schema=SCHEMA,
    )
    # Rückfüllung: die Zeile des JETZTigen Erstellers trägt die Owner-Rolle
    # (ersteller_id ist die übertragbare Besitzerrolle, s. Modell-Docstring).
    op.execute(
        f"UPDATE {SCHEMA}.private_group_members m"
        f" SET rolle = 'owner'"
        f" FROM {SCHEMA}.private_group_channels c"
        f" WHERE m.gruppe_id = c.id AND m.user_id = c.ersteller_id"
    )
    op.add_column(
        "private_group_channels",
        sa.Column("angeheftet_id", sa.String(length=64), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("private_group_channels", "angeheftet_id", schema=SCHEMA)
    op.drop_column("private_group_members", "stumm", schema=SCHEMA)
    op.drop_column("private_group_members", "rolle", schema=SCHEMA)
