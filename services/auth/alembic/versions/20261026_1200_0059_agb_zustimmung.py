"""agb_zustimmung — welche Fassung der Nutzungsbedingungen ein Konto wann annahm.

Bis hierher speicherte die Cloud keinen Nachweis, dass ein Konto den AGB
zugestimmt hat (Begründung in ``dcc_auth/agb.py``). ``agb_fassung`` hält das
ISO-Datum des „Stand“ der angenommenen Fassung, ``agb_akzeptiert_am`` den
Zeitpunkt.

Kein Backfill: Bestandskonten haben nie ausdrücklich zugestimmt, und ``NULL``
heißt genau das — sie sehen nach der nächsten Anmeldung den Zustimmungs-Dialog.

Rein additiv: zwei nullbare Spalten, nichts Bestehendes ändert sich.

Revision ID: 0059_agb_zustimmung
Revises: 0058_sitzung_nachfolger
Create Date: 2026-10-26 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen (``alembic_version.version_num`` ist varchar(32)).
revision: str = "0059_agb_zustimmung"
down_revision: str | None = "0058_sitzung_nachfolger"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("agb_fassung", sa.String(16), nullable=True), schema=SCHEMA
    )
    op.add_column(
        "users",
        sa.Column("agb_akzeptiert_am", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("users", "agb_akzeptiert_am", schema=SCHEMA)
    op.drop_column("users", "agb_fassung", schema=SCHEMA)
