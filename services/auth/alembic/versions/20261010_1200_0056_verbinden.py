"""verbinden — Server per Gerätecode mit einem Konto verbinden.

Seit Fassung 2 von ``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``
entsteht ein Server-Eintrag ohne Antrag: Der Betreiber bestätigt im Browser
einen Gerätecode, den sein Server angefragt hat (E1).

* ``worker_id_{chat,voice,media}`` werden nullable (E7): neue Einträge bekommen
  keine mehr. Kein Self-Host hat sie je gelesen (``07-render-env.sh`` setzt feste
  IDs), und der Vorrat war nach rund 307 Einträgen erschöpft.
* ``ohne_freigabe``: der Eintrag entstand über das Verbinden, nicht über einen
  freigegebenen Antrag. Nur ein Vermerk für die Admin-Übersicht.
* ``verbunden_at``: wann der Server seine Zugangsdaten abgeholt hat. Erst dann
  zählt er als eingerichtet (``_versorgte_instanzen``) — dieselbe Frage, die
  bei freigegebenen Servern das eingelöste Installer-Token beantwortet.
* ``users.server_verbinden_gesperrt``: Riegel für ein Konto, das nach einer
  Sperre immer neue Server verbindet (E8). Vorgabe aus.

Revision ID: 0056_verbinden
Revises: 0055_instanz_anzeige
Create Date: 2026-10-10 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen (``alembic_version.version_num`` ist varchar(32)).
revision: str = "0056_verbinden"
down_revision: str | None = "0055_instanz_anzeige"
branch_labels = None
depends_on = None

SCHEMA = "auth"
_WORKER = ("worker_id_chat", "worker_id_voice", "worker_id_media")


def upgrade() -> None:
    for spalte in _WORKER:
        op.alter_column(
            "registered_instances",
            spalte,
            existing_type=sa.SmallInteger(),
            nullable=True,
            schema=SCHEMA,
        )
    op.add_column(
        "registered_instances",
        sa.Column(
            "ohne_freigabe", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "registered_instances",
        sa.Column("verbunden_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "users",
        sa.Column(
            "server_verbinden_gesperrt",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    # Die Worker-Spalten bleiben nullable: zurück auf NOT NULL ginge nur, wenn
    # man die seither entstandenen Einträge samt Mitgliedschaften löschte.
    op.drop_column("users", "server_verbinden_gesperrt", schema=SCHEMA)
    op.drop_column("registered_instances", "verbunden_at", schema=SCHEMA)
    op.drop_column("registered_instances", "ohne_freigabe", schema=SCHEMA)
