"""Pulse-Laufwerk: der Urheber einer Datei getrennt vom letzten Ankündiger.

Gegenprüfung des Security-Audits (2026-11-05): ``ablage_pulse_objekte`` kannte
nur ``hochgeladen_von``, und eine Neuankündigung (das gemeinsame
``verzeichnis.puls``, ein Festigungs-Lauf) setzte es auf den Neuankündiger. Das
war für die Wettlauf-Erkennung von ``gelungen`` gewollt (Bughunt Runde 48),
nahm aber Löschrecht und Konto-Purge mit: jedes Mitglied mit ATTACH_FILES
konnte eine fremde Datei neu ankündigen, danach löschen, oder sie mit seinem
eigenen Konto verschwinden lassen.

``urheber_id`` hält, wer die Zeile ANGELEGT hat; ``hochgeladen_von`` bleibt der
letzte Ankündiger.

**Altbestand:** aus ``hochgeladen_von`` nachgetragen — für Dateien, die nie neu
angekündigt wurden (der Normalfall bei ``a-<id>.puls``), ist das der Urheber.
Beim ``verzeichnis.puls`` ist es der letzte Schreiber; das Verzeichnis nimmt
der Konto-Purge ohnehin nicht mehr mit.

Revision ID: 0110_pulse_urheber
Revises: 0109_ban_war_mitglied
Create Date: 2026-11-05 12:00:00.000000+00:00
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0110_pulse_urheber"
down_revision: str | Sequence[str] | None = "0109_ban_war_mitglied"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ablage_pulse_objekte",
        sa.Column("urheber_id", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )
    op.execute(
        f"UPDATE {SCHEMA}.ablage_pulse_objekte SET urheber_id = hochgeladen_von"
    )
    op.alter_column(
        "ablage_pulse_objekte", "urheber_id", nullable=False, schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_column("ablage_pulse_objekte", "urheber_id", schema=SCHEMA)
