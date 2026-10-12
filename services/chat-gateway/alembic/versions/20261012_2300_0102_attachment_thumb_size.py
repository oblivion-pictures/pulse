"""message_attachments.thumb_size — Größe des Vorschaubildes festhalten

Das Speicher-Kontingent einer Community summiert ``message_attachments.size``.
Das Vorschaubild, das der Klient zu einem Bild- oder Video-Anhang mit
hochlädt, stand in keiner Spalte: seine Größe wurde nur beim Ausstellen der
Upload-Adresse geprüft und dann vergessen. Damit zählte es weder gegen die
Dateigrenze noch gegen das Kontingent, und die Grenze fürs Vorschaubild selbst
war die volle Dateigrenze.

Die Spalte hält die Größe fest, damit ``belegte_bytes()`` sie mitrechnen kann.
NULL = kein Vorschaubild. Bestehende Zeilen bleiben NULL: ihre Größe ist nirgends
festgehalten, und sie nachzumessen hieße, jedes Objekt im Speicher abzufragen.
Das Kontingent unterschätzt den Altbestand deshalb um dessen Vorschaubilder
(Größenordnung: Kilo- bis Hunderte Kilobyte je Bild); neue Uploads zählen
vollständig.

Revision ID: 0102_attachment_thumb_size
Revises: 0101_zustellstand
Create Date: 2026-10-12 23:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0102_attachment_thumb_size"
down_revision: str | Sequence[str] | None = "0101_zustellstand"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "message_attachments",
        sa.Column("thumb_size", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("message_attachments", "thumb_size", schema=SCHEMA)
