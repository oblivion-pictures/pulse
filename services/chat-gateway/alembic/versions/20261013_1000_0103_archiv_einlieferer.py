"""archiv_zeilen.user_id — wer eine Archiv-Zeile eingeliefert hat; Lesen nach der Zeit

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

Kein Index für die Spalte: sie wird nur ausgeliefert, nie gefiltert.

Dazu der Index ``ix_archiv_zeilen_kanal_zeit`` (channel_id, erstellt_at, id):
``archiv_lesen`` liest seit 2026-10-14 neu nach alt nach der
Einlieferungszeit statt nach der ID (Gegenprüfung V3 — Bestandszeilen tragen
zufällige IDs, neue Zeilen kamen sonst hinter den ganzen Bestand). Er steht
hier statt in einer eigenen Migration, weil 0103 noch nicht ausgerollt war.

Neue Metadaten sind das kaum: wer wann an welchen Kanal sendet, sieht der
Server ohnehin an den Postfach-Zustellungen (``absender_user_id``).

Revision ID: 0103_archiv_einlieferer
Revises: 0102_attachment_thumb_size
Create Date: 2026-10-13 10:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0103_archiv_einlieferer"
down_revision: str | Sequence[str] | None = "0102_attachment_thumb_size"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "archiv_zeilen",
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_archiv_zeilen_kanal_zeit",
        "archiv_zeilen",
        ["channel_id", "erstellt_at", "id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_archiv_zeilen_kanal_zeit", table_name="archiv_zeilen", schema=SCHEMA)
    op.drop_column("archiv_zeilen", "user_id", schema=SCHEMA)
