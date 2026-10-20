"""webpush kette — Anmelde-Kette an Web-Push-Abos (Push-Bughunt 2026-10-20)

Wie Migration 0105 für FCM- und PushKit-Token: ein Web-Push-Abo lebte bis
hierher unabhängig von der Anmeldung, unter der es angelegt wurde. Wurde die
Sitzung eines Browsers widerrufen (Abmelden an einem anderen Gerät, „Sitzung
beenden", Passwortwechsel), zeigte er weiter Mitteilungen mit Absendernamen.
Die Spalte trägt die Anmelde-Kette aus dem Claim ``kette`` des Zugriffs-Tokens;
endet die Kette, löscht der chat-gateway die Zeilen (``push_widerruf.py``,
Abgleich ``geraetetoken_abgleich.py``).

Nullable und ohne Backfill: Bestandszeilen kennen ihre Kette nicht und
bekommen sie beim nächsten Anlegen oder Auffrischen des Abos. Bis dahin fallen
sie nur unter ein Ende ALLER Ketten des Kontos.

Kein eigener Index: gelöscht wird je Konto (``ix_web_push_subscriptions_user``),
und ein Konto hat eine Handvoll Abos.

Revision ID: 0108_webpush_kette
Revises: 0107_gruppen_rollen
Create Date: 2026-10-20 12:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0108_webpush_kette"
down_revision: str | Sequence[str] | None = "0107_gruppen_rollen"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "web_push_subscriptions", sa.Column("kette", sa.Text(), nullable=True), schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_column("web_push_subscriptions", "kette", schema=SCHEMA)
