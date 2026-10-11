"""geraetetoken kette — Anmelde-Kette an FCM- und PushKit-Token (iOS-Bughunt 2, C2)

Ein Gerätetoken lebte bis hierher unabhängig von der Anmeldung, unter der er
angemeldet wurde. Wurde die Sitzung eines verlorenen Telefons widerrufen, zeigte
es weiter Banner und klingelte. Die Spalte trägt die Anmelde-Kette aus dem
Claim ``kette`` des Zugriffs-Tokens; endet die Kette, löscht der chat-gateway
die Zeilen (``push_widerruf.py``, Nachricht ``dcc_shared.anmeldeketten``).

Nullable und ohne Backfill: Bestandszeilen kennen ihre Kette nicht und
bekommen sie beim nächsten App-Start (die Anmeldung upsertet jedes Mal). Bis
dahin fallen sie nur unter ein Ende ALLER Ketten des Kontos.

Kein eigener Index: gelöscht wird je Konto (``user_id`` führt den
Primärschlüssel), und ein Konto hat eine Handvoll Geräte.

Nummerierung: auf ``main`` trägt ``0101_zustellstand`` dieselbe Nummer wie
``0101_voip_tokens`` hier (bekannte Kollision, T1) — beim Landen entscheidet
die Zusammenführung; diese Revision hängt an ``0101_voip_tokens``.

Revision ID: 0102_geraetetoken_kette
Revises: 0101_voip_tokens
Create Date: 2026-10-11 15:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0102_geraetetoken_kette"
down_revision: str | Sequence[str] | None = "0101_voip_tokens"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABELLEN = ("fcm_tokens", "voip_tokens")


def upgrade() -> None:
    for tabelle in _TABELLEN:
        op.add_column(tabelle, sa.Column("kette", sa.Text(), nullable=True), schema=SCHEMA)


def downgrade() -> None:
    for tabelle in _TABELLEN:
        op.drop_column(tabelle, "kette", schema=SCHEMA)
