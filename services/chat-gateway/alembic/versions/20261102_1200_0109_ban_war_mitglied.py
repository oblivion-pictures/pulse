"""Bann merkt sich, ob das Ziel Mitglied war — Spalte ``was_member``.

Bughunt 2026-11-02: ``DELETE /guilds/{g}/bans/{uid}`` schickte JEDEM
Entbannten eine Moderations-DM mit Einladung, auch wer nie Mitglied war. Weil
Bannen keine Mitgliedschaft voraussetzt (vorsorgliches Bannen ist gewollt),
konnte jeder Community-Eigentümer mit Bannen + Entbannen beliebigen Konten
schreiben — an Freundschaftspflicht und Blockade vorbei. Seither gibt es die
Nachricht nur, wenn das Ziel beim Bannen Mitglied war.

**Altbestand:** nachgetragen aus dem Audit-Log, das seit dem Ban-Audit
(Commit 17ed8e930) je Bann ``{"was_member": …}`` mitschreibt. Ohne Eintrag gilt
``false`` — geschlossen statt offen: wer vor dem Update vorsorglich Fremde
gebannt hatte, könnte sonst die Lücke nach dem Update einmal pro Bann noch
nutzen. Den Preis zahlt nur ein Bann ohne Audit-Eintrag: der Entbannte bekommt
keine Einladung und tritt über einen normalen Link wieder bei.

Gezählt wird ein Eintrag ab dem Anlegen der Bann-Zeile (``banned_at``, mit
einer Minute Spielraum): ein Bann von früher, längst aufgehoben, sagt nichts
über den heutigen. Ein erneuerter Bann schreibt einen weiteren Eintrag
(``false``, denn ein Gebannter ist kein Mitglied), der erste behält
``true`` — wie ``ban_user`` es seither selbst hält. Der Abgleich läuft in
Python statt in SQL, damit er nicht am JSON-Dialekt hängt.

Revision ID: 0109_ban_war_mitglied
Revises: 0108_webpush_kette
Create Date: 2026-11-02 12:00:00.000000+00:00
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import timedelta

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0109_ban_war_mitglied"
down_revision: str | Sequence[str] | None = "0108_webpush_kette"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SPIELRAUM = timedelta(minutes=1)


def upgrade() -> None:
    op.add_column(
        "guild_bans",
        sa.Column("was_member", sa.Boolean(), nullable=False, server_default=sa.false()),
        schema=SCHEMA,
    )
    bind = op.get_bind()
    banne = bind.execute(
        sa.text(f"SELECT guild_id, user_id, banned_at FROM {SCHEMA}.guild_bans")
    ).all()
    if not banne:
        return
    eintraege = bind.execute(
        sa.text(
            f"SELECT guild_id, target_id, payload, created_at FROM {SCHEMA}.mod_audit_log "
            "WHERE action_type = 'ban'"
        )
    ).all()
    mitglied_seit: dict[tuple[int, int], list] = {}
    for guild_id, target_id, payload, created_at in eintraege:
        if isinstance(payload, str):
            payload = json.loads(payload)
        if isinstance(payload, dict) and payload.get("was_member") is True:
            mitglied_seit.setdefault((guild_id, target_id), []).append(created_at)
    for guild_id, user_id, banned_at in banne:
        zeiten = mitglied_seit.get((guild_id, user_id), [])
        if any(t >= banned_at - SPIELRAUM for t in zeiten):
            bind.execute(
                sa.text(
                    f"UPDATE {SCHEMA}.guild_bans SET was_member = true "
                    "WHERE guild_id = :g AND user_id = :u"
                ),
                {"g": guild_id, "u": user_id},
            )


def downgrade() -> None:
    op.drop_column("guild_bans", "was_member", schema=SCHEMA)
