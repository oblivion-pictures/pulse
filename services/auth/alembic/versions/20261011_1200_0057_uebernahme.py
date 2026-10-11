"""uebernahme — Widerspruchsfrist, bevor ein fremdes Konto eine Adresse übernimmt.

Nachtrag 2026-10-11 zu ``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``
(E2): Bestätigt ein fremdes Konto eine Adresse, die schon eingetragen ist,
entsteht ein Übernahme-Antrag. Erst nach 72 Stunden und einem zweiten Nachweis
wechselt der Eintrag; der bisherige Besitzer kann bis dahin widersprechen.

* ``alte_instanz_id`` ist der Schlüssel: Antrag, Sperre und Verfall hängen an
  der alten Instanz, nicht an der Adresse.
* ``neues_konto_id`` mit ``ON DELETE SET NULL``, nicht ``CASCADE`` — sonst höbe
  ein Wegwerf-Konto, das sich nach dem Widerspruch löscht, die Sperre auf.
* Höchstens ein offener Antrag je alter Instanz (partieller Unique-Index,
  wortgleich mit ``models_instances._UEBERNAHME_OFFEN``).

Rein additiv: eine neue Tabelle, nichts Bestehendes ändert sich.

Revision ID: 0057_uebernahme
Revises: 0056_verbinden
Create Date: 2026-10-11 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen (``alembic_version.version_num`` ist varchar(32)).
revision: str = "0057_uebernahme"
down_revision: str | None = "0056_verbinden"
branch_labels = None
depends_on = None

SCHEMA = "auth"
_OFFEN = "widersprochen_at IS NULL AND vollzogen_at IS NULL AND verfallen_at IS NULL"


def upgrade() -> None:
    op.create_table(
        "instanz_uebernahmen",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("alte_instanz_id", sa.BigInteger(), nullable=False),
        sa.Column("hostname", sa.Text(), nullable=False),
        sa.Column("neues_konto_id", sa.BigInteger(), nullable=True),
        sa.Column("beantragt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("frist_bis", sa.DateTime(timezone=True), nullable=False),
        sa.Column("widersprochen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("vollzogen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("verfallen_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["alte_instanz_id"], [f"{SCHEMA}.registered_instances.id"]),
        sa.ForeignKeyConstraint(["neues_konto_id"], [f"{SCHEMA}.users.id"], ondelete="SET NULL"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_instanz_uebernahmen_alte_instanz_id",
        "instanz_uebernahmen",
        ["alte_instanz_id"],
        schema=SCHEMA,
    )
    op.create_index(
        "uq_instanz_uebernahmen_offen",
        "instanz_uebernahmen",
        ["alte_instanz_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text(_OFFEN),
    )


def downgrade() -> None:
    op.drop_index("uq_instanz_uebernahmen_offen", "instanz_uebernahmen", schema=SCHEMA)
    op.drop_index("ix_instanz_uebernahmen_alte_instanz_id", "instanz_uebernahmen", schema=SCHEMA)
    op.drop_table("instanz_uebernahmen", schema=SCHEMA)
