"""archiv_zeilen.user_id — wer eine Archiv-Zeile eingeliefert hat

Bis hierher wusste der Server nicht, von wem eine Zeile stammt: einliefern
darf jedes Mitglied des Kanals, und den Autor nennt die Zeile nur in ihrer
verschlüsselten Nutzlast (``a``). Ein Mitglied konnte damit eine Zeile mit
dem Namen und der Kennung einer FREMDEN Nachricht einliefern, und auf einem
Frischgerät stand sie als Nachricht dieses Fremden da. Die Spalte hält das
Konto aus der Anmeldung; der Klient verwirft jede Zeile, deren ``a`` nicht
dazu passt (``web/src/lib/archiv/zeile.ts``).

Nullable und ohne Backfill: wer eine Bestandszeile eingeliefert hat, weiß
niemand mehr. Neue Zeilen tragen die Spalte immer (``routes/archiv.py``),
Bestandszeilen fallen spätestens mit dem 120-Tage-Sweeper weg. Wie der
Klient sie bis dahin behandelt, steht in ``archiv/zeile.ts``.

Kein Index: gelesen wird weiter je Kanal (``ix_archiv_zeilen_kanal_id``),
die Spalte wird nur ausgeliefert, nie gefiltert.

Neue Metadaten sind das kaum: wer wann an welchen Kanal sendet, sieht der
Server ohnehin an den Postfach-Zustellungen (``absender_user_id``).

Revision ID: 0102_archiv_einlieferer
Revises: 0101_zustellstand
Create Date: 2026-10-12 10:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0102_archiv_einlieferer"
down_revision: str | Sequence[str] | None = "0101_zustellstand"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "archiv_zeilen",
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("archiv_zeilen", "user_id", schema=SCHEMA)
