"""sitzung_nachfolger — welche Cookie-Sitzung eine erneuerte abgelöst hat.

``POST /session/renew`` ersetzt das vorgelegte Cookie durch ein neues und
entwertet das alte. Kommt das Set-Cookie der Antwort nie im Browser an (am
2026-10-17 in der iOS-Hülle gemessen: ein Seiten-Neuladen drei Sekunden nach
dem Erneuern), schickt der Klient weiter das entwertete Cookie. Bis hierher
antwortete jedes weitere Erneuern dann mit 204 ohne Cookie, weil an der alten
Sitzung keine Refresh-Token mehr hingen — der Klient hielt das für Erfolg, und
jeder cookie-pflichtige Aufruf scheiterte dauerhaft.

``replaced_by`` hält fest, wohin die Sitzung abgelöst wurde. Damit kann
``/session/renew`` den noch lebenden Nachfolger nachreichen, statt entweder zu
schweigen oder eine zweite Sitzung anzulegen (das Rennen aus Bughunt Runde 33,
s. ``session_renew.py``).

Ohne Fremdschlüssel (wie ``refresh_tokens.replaced_by``): der Sweeper löscht
abgelaufene Zeilen. Ohne Index: gelesen wird nur die Spalte einer schon per
Primärschlüssel gefundenen Zeile. Kein Backfill — alte Zeilen haben keinen
bekannten Nachfolger, und ``NULL`` heisst genau das.

Rein additiv: eine nullbare Spalte, nichts Bestehendes ändert sich.

Revision ID: 0058_sitzung_nachfolger
Revises: 0057_uebernahme
Create Date: 2026-10-17 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# Revision-ID max. 32 Zeichen (``alembic_version.version_num`` ist varchar(32)).
revision: str = "0058_sitzung_nachfolger"
down_revision: str | None = "0057_uebernahme"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "user_sessions",
        sa.Column("replaced_by", postgresql.UUID(as_uuid=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("user_sessions", "replaced_by", schema=SCHEMA)
