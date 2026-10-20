"""Web-Push für Erwähnungen, Freundes-Ereignisse und Community-Einladungen.

Aus ``push.py`` gelöst (Größen-Policy, Push-Bughunt 2026-10-20); ``push.py``
re-exportiert die Funktionen. Gesendet wird über ``push._send_one`` und
``push._fan_out_payload`` — über das Modul, nicht über eigene Namen, damit
die Tests, die diese Senken dort ersetzen, auch diese Wege treffen.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import UTC, datetime

from sqlalchemy import delete, select, update

from dcc_chat_gateway import fcm_hinweise
from dcc_chat_gateway.models import WebPushSubscription

log = logging.getLogger("dcc_chat_gateway.push")


# ---------------------------------------------------------------------------
# Payload contract — keep in sync with the Service Worker + Electron notifier.
#
# This is the documented shape ``send_push_to_user`` consumes (and what the
# FE service worker / Electron renderer event handler must decode).
#
# {
#   "type":         "mention",            # discriminator; future: "dm" etc.
#   "title":        "<author_name>",      # 1st notification line
#   "body":         "<snippet>",          # 2nd line, max ~120 chars
#   "channel_id":   "<snowflake string>",
#   "message_id":   "<snowflake string>",
#   "guild_id":     "<snowflake string>" | null,   # null for DMs
#   "author_name":  "<username>",
#   "icon":         "<absolute https url>" | null  # avatar; null → SW falls
#                                                  # back to app icon
# }
#
# All snowflake-shaped ids are STRINGS over the API boundary (CLAUDE.md).
# ``guild_id`` is null for DM mentions; the FE uses that to route the
# notification's click action to ``/app/dms/<channel_id>`` vs
# ``/app/guilds/<guild_id>/channels/<channel_id>``.
MENTION_PAYLOAD_SCHEMA = {
    "type": "string",
    "title": "string",
    "body": "string",
    "channel_id": "string",
    "message_id": "string",
    "guild_id": "string|null",
    "author_name": "string",
    "icon": "string|null",
}


async def fan_out_mention_push(
    *,
    user_ids: set[int],
    author_name: str,
    content: str,
    channel_id: int,
    message_id: int,
    guild_id: int | None,
    redis=None,
) -> None:
    """Build the canonical mention payload + push it to each user.

    Daneben geht die Erwähnung als Mitteilung an die Handys der Empfänger
    (``fcm_hinweise``, nur in der Cloud) — unabhängig davon, ob VAPID
    eingerichtet ist. ``redis`` braucht nur dieses Handy-Bein („Nicht stören“
    live, Fähigkeiten der Geräte); ohne es gilt die dauerhafte Einstellung.

    Opens a *single* DB session (via ``routes.ws_ops.SessionLocal``) and
    loads all subscriptions for all recipients in one query, then fans
    out sends concurrently in thread-pool workers (pywebpush is sync).
    Dead-endpoint deletes and last_used_at refreshes are batched into two
    bulk statements after all sends complete, so the DB pool is held for
    only one short window regardless of recipient count.

    Tests rebind ``routes.ws_ops.SessionLocal`` to their fixture's
    sessionmaker; production uses the prod factory.

    Never raises — push failures, missing VAPID, or an empty subscription
    set must not break the message-send REST path. Caller (route layer)
    fires this *after* the WS broadcast so the in-app counter bumps
    even if the push half is misconfigured.
    """
    from dcc_chat_gateway import push  # spät: push importiert dieses Modul

    if not user_ids:
        return

    # 100-char snippet — long enough to be useful, short enough that an
    # OS-level toast doesn't truncate weirdly. Strip mention markers so
    # the preview doesn't read "<@123456789> please look". Use a soft
    # rstrip → ellipsis if we cut.
    body = _make_snippet(content)
    fcm_hinweise.erwaehnung(
        user_ids=user_ids,
        author_name=author_name,
        text=body,
        channel_id=channel_id,
        message_id=message_id,
        guild_id=guild_id,
        redis=redis,
    )

    settings = push.get_settings()
    vapid = push.ensure_vapid(settings)
    if vapid is None:
        return
    payload_base = {
        "type": "mention",
        "title": author_name or "Pulse",
        "body": body,
        "channel_id": str(channel_id),
        "message_id": str(message_id),
        "guild_id": str(guild_id) if guild_id is not None else None,
        "author_name": author_name or "",
        "icon": None,  # chat-gateway has no avatar URL; FE/SW fallback.
    }
    serialised_body = json.dumps(payload_base, separators=(",", ":"))
    vapid_claims = {"sub": settings.vapid_subject}

    # Late import: routes.ws_ops → push would cycle.
    from dcc_chat_gateway.routes import ws_ops as _routes_ws_ops

    try:
        async with _routes_ws_ops.SessionLocal() as session:
            # Single query for all recipients — O(1) DB round-trip.
            uid_list = list(user_ids)
            rows = (
                await session.execute(
                    select(WebPushSubscription).where(
                        WebPushSubscription.user_id.in_(uid_list)
                    )
                )
            ).scalars().all()

            if not rows:
                return

            # Send all subscriptions concurrently in thread-pool workers;
            # pywebpush is sync-only so we must offload.  ``return_exceptions=True``
            # so a CancelledError can't skip the dead-endpoint cleanup below
            # (see send_push_to_user for the rationale); ``_send_one`` itself
            # never raises, so any exception entry is a cancelled future and
            # falls through to the transient "warn" path.
            results = await asyncio.gather(
                *(
                    asyncio.to_thread(
                        push._send_one,
                        endpoint=r.endpoint,
                        p256dh=r.p256dh,
                        auth_secret=r.auth_secret,
                        body=serialised_body,
                        vapid_pem=vapid.private_pem,
                        vapid_claims=vapid_claims,
                    )
                    for r in rows
                ),
                return_exceptions=True,
            )

            ok_ids: list[int] = []
            dead_ids: list[int] = []
            for row, outcome in zip(rows, results, strict=True):
                if outcome == "ok":
                    ok_ids.append(row.id)
                elif outcome == "dead":
                    dead_ids.append(row.id)
                # "warn" → leave alone (transient).

            # Two bulk statements — one session, one commit.
            if dead_ids:
                await session.execute(
                    delete(WebPushSubscription).where(
                        WebPushSubscription.id.in_(dead_ids)
                    )
                )
            if ok_ids:
                await session.execute(
                    update(WebPushSubscription)
                    .where(WebPushSubscription.id.in_(ok_ids))
                    .values(last_used_at=datetime.now(UTC))
                )
            if dead_ids or ok_ids:
                await session.commit()
    except Exception:  # noqa: BLE001
        log.exception("fan_out_mention_push failed")


async def fan_out_friend_push(
    *,
    recipient_id: int,
    actor_name: str,
    kind: str,
    actor_id: int | None = None,
    redis=None,
) -> None:
    """Push a closed-browser notification for a friend event.

    ``kind`` is ``"friend_request"`` (incoming request) or ``"friend_accept"``
    (request accepted). No channel/message — ``target_url`` routes the click to
    the friends page.

    Eine eingehende Anfrage geht zusätzlich an die Handys des Empfängers
    (``fcm_hinweise``, nur in der Cloud); dafür braucht es ``actor_id``.
    """
    from dcc_chat_gateway import push  # spät: push importiert dieses Modul

    if kind == "friend_request":
        body = f"{actor_name} möchte dich als Freund hinzufügen"
    elif kind == "friend_accept":
        body = f"{actor_name} hat deine Freundschaftsanfrage angenommen"
    else:
        return
    payload = {
        "type": kind,
        "title": actor_name or "Pulse",
        "body": body,
        "channel_id": None,
        "message_id": None,
        "guild_id": None,
        "author_name": actor_name or "",
        "icon": None,
        "target_url": "/app/friends",
    }
    if kind == "friend_request" and actor_id is not None:
        fcm_hinweise.freundschaft(
            recipient_id=recipient_id, actor_id=actor_id, actor_name=actor_name, redis=redis
        )
    await push._fan_out_payload({recipient_id}, payload)


async def fan_out_community_invite_push(
    *, recipient_id: int, inviter_name: str, guild_name: str, guild_id: int
) -> None:
    """Push a closed-browser notification for a community invite.

    Entscheidung 2d (2026-09-21): Einladungen lösten kein Web-Push aus
    (Freundschaftsanfragen taten es) — geschlossen-browser Nutzer sahen
    die Karte erst beim nächsten App-Start. ``target_url`` führt auf die
    App (die Karte liegt im Einladungs-Eingang), der Body nennt Einladenden
    und Community."""
    from dcc_chat_gateway import push  # spät: push importiert dieses Modul

    payload = {
        "type": "community_invite",
        "title": inviter_name or "Pulse",
        "body": f"{inviter_name} lädt dich ein: {guild_name}",
        "channel_id": None,
        "message_id": None,
        # target_url entscheidet den Klick (ohne channel_id → /app).
        "guild_id": str(guild_id),
        "author_name": inviter_name or "",
        "icon": None,
        "target_url": "/app",
    }
    await push._fan_out_payload({recipient_id}, payload)


def _make_snippet(content: str, limit: int = 100) -> str:
    """One-line, marker-free preview of the message content.

    Replaces ``<@123>``/``<@&123>`` with empty + ``@everyone``/``@here``
    with ``@everyone`` so the preview reads naturally. Collapses
    whitespace + truncates with an ellipsis when over ``limit`` chars.
    """
    text = re.sub(r"<@&?\d{1,20}>", "", content)
    text = re.sub(r"@(everyone|here)\b", "@everyone", text)
    text = " ".join(text.split())  # collapse runs of whitespace
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


__all__ = [
    "MENTION_PAYLOAD_SCHEMA",
    "fan_out_community_invite_push",
    "fan_out_friend_push",
    "fan_out_mention_push",
]
